import { colors, Command, Select } from "./deps.ts";
import { AWS, EC2, SSO } from "./deps.ts";
import { fromSso } from "./src/ssoTokenProvider.ts";

const command = new Command()
  .name("sm")
  .version("0.0.2")
  .description("A single command line tool for SSM'ing into ec2 instances");

const promptForSsoSession = async () => {
  const ssoSessions = Object.entries(await AWS.loadSsoSessionData()).map(
    ([key, value]) => ({
      sso_session_name: key,
      sso_start_url: value.sso_start_url ?? "",
      sso_region: value.sso_region ?? "",
    }),
  );

  if (ssoSessions.length === 0) {
    console.error(
      `No sso-session found in ${colors.bold("~/.aws/config")}. Please run ${
        colors.underline("aws configure sso-session")
      } first.`,
    );
    Deno.exit(1);
  } else {
    console.log(
      `Found ${ssoSessions.length} SSO sessions in ${
        colors.bold("~/.aws/config")
      }`,
    );
  }

  ssoSessions.forEach((session, idx) => {
    const isOnlyOne = ssoSessions.length === 1 && idx === 0;
    console.log(
      [
        isOnlyOne ? "  →" : "",
        colors.bold(session.sso_session_name),
        colors.dim(session.sso_start_url),
        colors.dim(session.sso_region),
        isOnlyOne ? "(default)" : "",
      ].join("  "),
    );
  });

  console.log("");

  let selectedSession = ssoSessions[0];

  if (ssoSessions.length > 1) {
    selectedSession = await Select.prompt({
      message: "Select an AWS SSO session",
      options: ssoSessions.map((session) => ({
        name: session.sso_session_name,
        value: session,
      })).sort((a, b) => a.name.localeCompare(b.name)),
    }) as any; // There's a bug in the typings for Select.prompt.
  }

  return selectedSession;
};

const getAccountsAndRoles = async (
  ssoClient: SSO.SSOClient,
  ssoAccessToken: string,
) => {
  const accounts = await ssoClient.send(
    new SSO.ListAccountsCommand({
      accessToken: ssoAccessToken,
    }),
  );

  const rolesPerAccount = await Promise.all(
    accounts.accountList?.map((account) =>
      ssoClient.send(
        new SSO.ListAccountRolesCommand({
          accessToken: ssoAccessToken,
          accountId: account.accountId,
        }),
      )
    ) ?? [],
  );

  return accounts.accountList?.map((account) => {
    const roles = rolesPerAccount.find((roles) =>
      roles.roleList?.find((role) =>
        role.accountId === account.accountId
      )
    )?.roleList ?? [];

    return {
      ...account,
      roles: roles.map((role) => role.roleName),
    };
  });
};

const startSsmProcessIntoInstance = (
  { region, instanceId, credentials }: {
    region: string;
    instanceId: string;
    credentials: SSO.RoleCredentials;
  },
) => {
  const ssmCommand = new Deno.Command("aws", {
    args: [
      "ssm",
      "start-session",
      "--target",
      instanceId,
    ],
    env: {
      AWS_ACCESS_KEY_ID: credentials.accessKeyId!,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey!,
      AWS_SESSION_TOKEN: credentials.sessionToken!,
      AWS_REGION: region,
    },
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });

  const ssmSubprocess = ssmCommand.spawn();
  ssmSubprocess.ref();

  // Listen to all signals and forward them to the subprocess.
  const forwardedSignals: Deno.Signal[] = [
    "SIGINT",
    "SIGQUIT",
    "SIGTERM",
    "SIGTSTP",
    "SIGABRT",
  ];
  for (const signal of forwardedSignals) {
    Deno.addSignalListener(signal, () => ssmSubprocess.kill(signal));
  }
};

if (import.meta.main) {
  await command.parse(Deno.args);

  const selectedSession = await promptForSsoSession();

  const ssoTokenProvider = fromSso({
    ssoRegion: selectedSession.sso_region,
    ssoSessionName: selectedSession.sso_session_name,
  });

  const ssoAccessToken = await ssoTokenProvider();

  const ssoClient = new SSO.SSOClient({
    region: selectedSession.sso_region,
  });

  let accountsWithRoles;

  try {
    accountsWithRoles = await getAccountsAndRoles(
      ssoClient,
      ssoAccessToken.token,
    );
  } catch (e) {
    if (
      e instanceof SSO.UnauthorizedException &&
      // We check specifically for this message because the SDK doesn't
      // distinguish between "token expired" and "you lack iam privs".
      e.message === "Session token not found or invalid"
    ) {
      console.error(
        `SSO token expired. Run ${
          colors.underline(
            "aws sso login --sso-session " + selectedSession.sso_session_name,
          )
        } first.`,
      );

      Deno.exit(1);
    }

    throw e;
  }

  if (!accountsWithRoles || accountsWithRoles.length === 0) {
    console.error("No accounts or roles found");
    Deno.exit(1);
  }

  const selectedAccount: { accountId: number; roleName: string } = await Select
    .prompt({
      message: "Select an AWS account and role",
      options: accountsWithRoles.map((account) => ({
        name: `${account.accountName} #${account.accountId}`,
        options: account.roles.map((role) => ({
          name: `#${account.accountId} ${role}`,
          value: { accountId: account.accountId, roleName: role },
        })).sort((a, b) => a.name!.localeCompare(b.name!)),
      })).sort((a, b) => a.name.localeCompare(b.name)),
    }) as any;

  const shortTermCredentialsOutput = await ssoClient.send(
    new SSO.GetRoleCredentialsCommand({
      accessToken: ssoAccessToken.token,
      accountId: selectedAccount.accountId.toString(),
      roleName: selectedAccount.roleName,
    }),
  );

  // This is purely for convenience. We strip out the expiration date and
  // mark the remaining short-term credential fields as required to satisfy
  // the compiler.
  const credentials = shortTermCredentialsOutput.roleCredentials! as Omit<
    Required<SSO.RoleCredentials>,
    "expiration"
  >;

  const ec2Client = new EC2.EC2Client({
    region: selectedSession.sso_region,
    credentials,
  });

  const instances = await ec2Client.send(
    new EC2.DescribeInstancesCommand({}),
  );

  const namedInstances: { instanceId: string; name: string }[] = [];

  for (const reservation of instances.Reservations ?? []) {
    reservation.Instances?.forEach((instance) => {
      const name = instance.Tags?.filter((tag) => tag.Key === "Name").map((
        tag,
      ) => tag.Value).join(", ") ?? "[no name]";

      namedInstances.push({ instanceId: instance.InstanceId!, name });
    });
  }

  const selectedInstance: string = await Select.prompt({
    message: "SSM into an EC2 instance",
    options: namedInstances.sort(
      (a, b) => a.name.localeCompare(b.name),
    ).map((instance) => ({
      name: `${instance.instanceId} - ${instance.name}`,
      value: instance.instanceId,
    })),
  }) as any;

  startSsmProcessIntoInstance({
    region: selectedSession.sso_region,
    instanceId: selectedInstance,
    credentials,
  });
}

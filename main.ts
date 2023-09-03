import {
  AwsConfig,
  colors,
  Command,
  Ec2,
  Select,
  type SelectOption,
  type SelectOptionGroup,
  Sso,
} from "./deps.ts";
import { fromSso, TokenError } from "./src/ssoTokenProvider.ts";

const command = new Command()
  .name("sm")
  .version("0.0.4")
  .description("A single command line tool for SSM'ing into ec2 instances");

const promptForSsoSession = async () => {
  const ssoSessions = Object.entries(await AwsConfig.loadSsoSessionData()).map(
    ([key, value]) => ({
      sso_session_name: key,
      sso_start_url: value.sso_start_url ?? "",
      sso_region: value.sso_region ?? "",
    }),
  );

  if (ssoSessions.length === 0) {
    const path = colors.bold("~/.aws/config");
    const command = colors.underline("aws configure sso-session");
    console.error(
      `No sso-session found in ${path}. Run ${command} first.`,
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
      })).sort((a, b) => a.name.localeCompare(b.name)) as SelectOption<
        typeof ssoSessions[number]
      >[],
    });
  }

  return selectedSession;
};

const getAccountsAndRoles = async (
  ssoClient: Sso.SSOClient,
  ssoAccessToken: string,
) => {
  const accounts = await ssoClient.send(
    new Sso.ListAccountsCommand({
      accessToken: ssoAccessToken,
    }),
  );

  const rolesPerAccount = await Promise.all(
    accounts.accountList?.map((account) =>
      ssoClient.send(
        new Sso.ListAccountRolesCommand({
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
    credentials: Sso.RoleCredentials;
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

  const ssoClient = new Sso.SSOClient({
    region: selectedSession.sso_region,
  });

  let ssoTokenProvider;
  let ssoAccessToken;

  try {
    ssoTokenProvider = fromSso({
      ssoRegion: selectedSession.sso_region,
      ssoSessionName: selectedSession.sso_session_name,
    });
    ssoAccessToken = await ssoTokenProvider();
  } catch (e) {
    if (e instanceof TokenError) {
      const command =
        `aws sso login --sso-session ${selectedSession.sso_session_name}`;

      const message = e.code === "SSO_TOKEN_FILE_NOT_FOUND"
        ? "SSO token file not found"
        : "SSO token expired";

      console.error(`${message}. Run ${colors.underline(command)} first.`);

      Deno.exit(1);
    }

    throw e;
  }

  const accountsWithRoles = await getAccountsAndRoles(
    ssoClient,
    ssoAccessToken.token,
  );

  if (!accountsWithRoles || accountsWithRoles.length === 0) {
    console.error("No accounts or roles found");
    Deno.exit(1);
  }

  accountsWithRoles.sort((a, b) =>
    a.accountName!.localeCompare(b.accountName!)
  );
  accountsWithRoles.forEach((account) => {
    account.roles.sort((a, b) => a!.localeCompare(b!));
  });

  const selectedAccount = await Select
    .prompt({
      message: "Select an AWS account and role",
      search: true,
      format: (account) => `${account.accountId}-${account.roleName}`,
      options: accountsWithRoles.map((account) => ({
        name: `${account.accountName} #${account.accountId}`,
        options: account.roles.map((role) => ({
          name: role,
          value: { accountId: account.accountId, roleName: role },
        })),
      })) as SelectOptionGroup<{
        accountId: number;
        roleName: string;
      }>[],
    });

  const shortTermCredentialsOutput = await ssoClient.send(
    new Sso.GetRoleCredentialsCommand({
      accessToken: ssoAccessToken.token,
      accountId: selectedAccount.accountId.toString(),
      roleName: selectedAccount.roleName,
    }),
  );

  // This is purely for convenience. We strip out the expiration date and
  // mark the remaining short-term credential fields as required to satisfy
  // the compiler.
  const credentials = shortTermCredentialsOutput.roleCredentials! as Omit<
    Required<Sso.RoleCredentials>,
    "expiration"
  >;

  const ec2Client = new Ec2.EC2Client({
    region: selectedSession.sso_region,
    credentials,
  });

  let instances;

  try {
    instances = await ec2Client.send(
      new Ec2.DescribeInstancesCommand({}),
    );
  } catch (e) {
    if (
      e instanceof Ec2.EC2ServiceException && e.name === "UnauthorizedOperation"
    ) {
      console.error(`Unauthorized to perform ec2:DescribeInstances`);
      Deno.exit(1);
    }
    throw e;
  }

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
    search: true,
    options: namedInstances.sort(
      (a, b) => a.name.localeCompare(b.name),
    ).map((instance) => ({
      name: `${instance.instanceId} - ${instance.name}`,
      value: instance.instanceId,
    })) as SelectOption<string>[],
  });

  startSsmProcessIntoInstance({
    region: selectedSession.sso_region,
    instanceId: selectedInstance,
    credentials,
  });
}

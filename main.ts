import { colors, Command, Select } from "./deps.ts";
import { AWS, EC2, SSO } from "./deps.ts";

const command = new Command()
  .name("sm")
  .version("0.0.1")
  .description("A single command line tool for SSM'ing into ec2 instances");

if (import.meta.main) {
  await command.parse(Deno.args);

  const ssoSessions = Object.entries(await AWS.loadSsoSessionData()).map(
    ([key, value]) => ({
      sso_session_name: key,
      sso_start_url: value.sso_start_url ?? "",
      sso_region: value.sso_region ?? "",
    }),
  );

  if (ssoSessions.length === 0) {
    console.log(
      `No sso-session found in ${
        colors.bold("~/.aws/config")
      }. Please run \`aws configure sso-session\` first.`,
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
        "(default)",
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

  let ssoToken: AWS.SSOToken;

  try {
    ssoToken = await AWS.getSSOTokenFromFile(selectedSession.sso_session_name);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw e;
    }

    // todo: if this fails, do an sso login automatically
    console.log(
      "SSO token not found. Run `aws sso login --sso-session" +
        selectedSession.sso_session_name + "` first.",
    );

    Deno.exit(1);
  }

  // todo: if this fails, also do an aws sso login automatically
  const ssoClient = new SSO.SSOClient({
    region: selectedSession.sso_region,
  });

  const accounts = await ssoClient.send(
    new SSO.ListAccountsCommand({
      accessToken: ssoToken.accessToken,
    }),
  );

  const rolesPerAccount = await Promise.all(
    accounts.accountList?.map((account) =>
      ssoClient.send(
        new SSO.ListAccountRolesCommand({
          accessToken: ssoToken.accessToken,
          accountId: account.accountId,
        }),
      )
    ) ?? [],
  );

  const accountsWithRoles = accounts.accountList?.map((account) => {
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

  const shortTermCredentials = await ssoClient.send(
    new SSO.GetRoleCredentialsCommand({
      accessToken: ssoToken.accessToken,
      accountId: selectedAccount.accountId.toString(),
      roleName: selectedAccount.roleName,
    }),
  );

  const ec2Client = new EC2.EC2Client({
    region: selectedSession.sso_region,
    credentials: {
      accessKeyId: shortTermCredentials.roleCredentials?.accessKeyId!,
      sessionToken: shortTermCredentials.roleCredentials?.sessionToken!,
      secretAccessKey: shortTermCredentials.roleCredentials?.secretAccessKey!,
    },
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

  // run aws ssm start-session --target $instanceId
  const ssmCommand = new Deno.Command("aws", {
    args: [
      "ssm",
      "start-session",
      "--target",
      selectedInstance,
    ],
    env: {
      AWS_ACCESS_KEY_ID: shortTermCredentials.roleCredentials?.accessKeyId!,
      AWS_SECRET_ACCESS_KEY: shortTermCredentials.roleCredentials
        ?.secretAccessKey!,
      AWS_SESSION_TOKEN: shortTermCredentials.roleCredentials?.sessionToken!,
      AWS_REGION: selectedSession.sso_region,
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
}

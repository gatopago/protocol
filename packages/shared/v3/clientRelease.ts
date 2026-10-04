export const CLIENT_COMPATIBILITY_PATH = '/app/v1/client-compatibility';

export const CLIENT_RELEASE_ID = 'wallet-client-v3.1';
export const WALLET_API_VERSION = 'wallet-core-v3.1';
export const CLIENT_RELEASE_HEADERS = Object.freeze({
  release: 'X-GatoPago-Client-Release',
  api: 'X-GatoPago-Api-Version',
  environment: 'X-GatoPago-Environment',
  generation: 'X-GatoPago-Account-Generation',
  manifest: 'X-GatoPago-Contract-Manifest',
});
export const CLIENT_STATUS_HEADER = 'X-GatoPago-Client-Status';

type DeploymentEnvironment = 'production';
export type AccountReleaseContext = Readonly<{
  generation: string;
  contract_manifest_version: string;
}>;
export type ReleasePolicy = Readonly<{
  api_version: string;

  releases: readonly Readonly<{ client_release_id: string; accepted_until: number | null }>[];
  account_profiles: readonly AccountReleaseContext[];
}>;

export const WALLET_RELEASE_POLICY: ReleasePolicy = Object.freeze({
  api_version: WALLET_API_VERSION,
  releases: Object.freeze([
    Object.freeze({ client_release_id: CLIENT_RELEASE_ID, accepted_until: null }),
  ]),

  account_profiles: Object.freeze([]),
});

export function clientMutationHeaders(
  environment: DeploymentEnvironment,
  account?: AccountReleaseContext,
): Record<string, string> {
  return {
    [CLIENT_RELEASE_HEADERS.release]: CLIENT_RELEASE_ID,
    [CLIENT_RELEASE_HEADERS.api]: WALLET_API_VERSION,
    [CLIENT_RELEASE_HEADERS.environment]: environment,
    [CLIENT_RELEASE_HEADERS.generation]: account?.generation ?? 'none',
    [CLIENT_RELEASE_HEADERS.manifest]: account?.contract_manifest_version ?? 'none',
  };
}

function activeReleases(policy: ReleasePolicy, now: number) {
  return policy.releases.filter(
    (release) => release.accepted_until === null || now < release.accepted_until,
  );
}

export function publicClientCompatibility(
  environment: DeploymentEnvironment,
  policy: ReleasePolicy,
  now: number,
) {
  const accepted = activeReleases(policy, now).map((release) => release.client_release_id);
  return {
    policy_version: 1 as const,
    environment,
    api_version: policy.api_version,
    minimum_mutating_release: accepted[0] ?? null,
    accepted_mutating_releases: accepted,
    account_profiles: policy.account_profiles.map((profile) => ({ ...profile })),
  };
}

export function mutationCompatibility(
  headers: Pick<Headers, 'get'>,
  environment: DeploymentEnvironment,
  scope: 'identity' | 'account',
  policy: ReleasePolicy,
  now: number,
): 'compatible' | 'update-required' | 'account-unavailable' {
  if (!Number.isSafeInteger(now) || now < 0) return 'update-required';
  const release = headers.get(CLIENT_RELEASE_HEADERS.release);
  const api = headers.get(CLIENT_RELEASE_HEADERS.api);
  const generation = headers.get(CLIENT_RELEASE_HEADERS.generation);
  const manifest = headers.get(CLIENT_RELEASE_HEADERS.manifest);

  if (
    headers.get(CLIENT_RELEASE_HEADERS.environment) !== environment ||
    api !== policy.api_version ||
    !release ||
    release.length > 80 ||
    !activeReleases(policy, now).some((item) => item.client_release_id === release)
  ) {
    return 'update-required';
  }
  if (scope === 'identity')
    return generation === 'none' && manifest === 'none' ? 'compatible' : 'update-required';
  if (!policy.account_profiles.length) return 'account-unavailable';
  return policy.account_profiles.some(
    (profile) =>
      profile.generation === generation && profile.contract_manifest_version === manifest,
  )
    ? 'compatible'
    : 'update-required';
}

export function isClientUpdateError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'client/update-required'
  );
}

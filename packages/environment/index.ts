export type NetworkId = `${string}:${string}`;

export interface Environment {
  schema_version: 1;
  environment: 'production';
  status: 'unprovisioned' | 'provisioned';
  web_origin: string;
  business_origin: string;
  api_origin: string;
  webauthn_rp_id: string;
  webauthn_allowed_origins: string[];
  api_modes: ('test' | 'live')[];
  blockchain_tiers: ('testnet' | 'mainnet')[];
  wallet_candidates: NetworkId[];
  wallet_enabled: NetworkId[];
  payment_live_enabled: boolean;
  firebase_project_id: string | null;
}

const strings = (value: unknown, allowed?: readonly string[]) =>
  Array.isArray(value) &&
  value.every((item) => typeof item === 'string' && (!allowed || allowed.includes(item)));

function isEnvironment(input: unknown): input is Environment {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const c = input as Record<string, unknown>;
  return (
    Object.keys(c).length === 14 &&
    c.schema_version === 1 &&
    c.environment === 'production' &&
    (c.status === 'unprovisioned' || c.status === 'provisioned') &&
    typeof c.web_origin === 'string' &&
    typeof c.business_origin === 'string' &&
    typeof c.api_origin === 'string' &&
    typeof c.webauthn_rp_id === 'string' &&
    strings(c.webauthn_allowed_origins) &&
    strings(c.api_modes, ['test', 'live']) &&
    strings(c.blockchain_tiers, ['testnet', 'mainnet']) &&
    strings(c.wallet_candidates) &&
    strings(c.wallet_enabled) &&
    [...(c.wallet_candidates as string[]), ...(c.wallet_enabled as string[])].every((id) =>
      /^[a-z0-9-]{3,8}:[A-Za-z0-9-]{1,32}$/.test(id),
    ) &&
    typeof c.payment_live_enabled === 'boolean' &&
    (c.firebase_project_id === null || typeof c.firebase_project_id === 'string')
  );
}

export function parseEnvironment(input: unknown): Environment {
  if (!isEnvironment(input)) throw new Error('Invalid environment');
  const config = input;
  for (const origin of [config.web_origin, config.api_origin, config.business_origin]) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackOrigin(origin)))
    ) {
      throw new Error('Environment requires canonical HTTPS origins or local loopback HTTP');
    }
  }
  if (
    config.webauthn_rp_id !== new URL(config.web_origin).hostname ||
    config.webauthn_allowed_origins.length !== 1 ||
    config.webauthn_allowed_origins[0] !== config.web_origin
  ) {
    throw new Error('Environment origins and RP do not match');
  }

  if (
    config.payment_live_enabled ||
    config.api_modes.some((mode) => mode !== 'test') ||
    config.blockchain_tiers.some((tier) => tier !== 'testnet')
  ) {
    throw new Error('Mainnet/live is not authorized for E0-E4');
  }
  if (
    config.status === 'unprovisioned' &&
    (config.firebase_project_id !== null || config.wallet_enabled.length > 0)
  ) {
    throw new Error('Unprovisioned environment cannot declare working resources');
  }
  if (config.status === 'provisioned' && config.firebase_project_id === null)
    throw new Error('Missing environment Firebase project');
  if (config.wallet_enabled.some((network) => !config.wallet_candidates.includes(network)))
    throw new Error('Enabled network was not a candidate');
  return structuredClone(config);
}

export interface EnvironmentVariables {
  GATOPAGO_ENVIRONMENT?: string;
  GATOPAGO_WEB_ORIGIN?: string;
  GATOPAGO_API_ORIGIN?: string;
  GATOPAGO_BUSINESS_ORIGIN?: string;
  GATOPAGO_WALLET_NETWORKS?: string;
  FIREBASE_PROJECT_ID?: string;
}

function isLoopbackOrigin(origin: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
}

export function isLocalEnvironment(config: Environment): boolean {
  return [config.web_origin, config.api_origin].every(
    (origin) => new URL(origin).protocol === 'http:' && isLoopbackOrigin(origin),
  );
}

export function environmentFromVariables(input: EnvironmentVariables): Environment {
  const required = (key: keyof EnvironmentVariables): string => {
    const value = input[key];
    if (!value || value !== value.trim()) throw new Error(`Missing or invalid ${key}`);
    return value;
  };
  const web = required('GATOPAGO_WEB_ORIGIN');
  const networks = required('GATOPAGO_WALLET_NETWORKS').split(',');
  return parseEnvironment({
    schema_version: 1,
    environment: required('GATOPAGO_ENVIRONMENT'),
    status: 'provisioned',
    web_origin: web,
    api_origin: required('GATOPAGO_API_ORIGIN'),
    business_origin: required('GATOPAGO_BUSINESS_ORIGIN'),
    webauthn_rp_id: new URL(web).hostname,
    webauthn_allowed_origins: [web],
    api_modes: ['test'],
    blockchain_tiers: ['testnet'],
    wallet_candidates: networks,
    wallet_enabled: networks,
    payment_live_enabled: false,
    firebase_project_id: required('FIREBASE_PROJECT_ID'),
  });
}

export function assertProvisioned(config: Environment): void {
  if (parseEnvironment(config).status !== 'provisioned')
    throw new Error('Environment is not provisioned');
}

const flowCollections = new Set([
  'merchant',
  'health',
  'organizations',
  'memberships',
  'projects',
  'customers',
  'settlement_accounts',
  'payment_links',
  'payment_intents',
  'quotes',
  'events',
  'webhook_endpoints',
]);
const walletCollections = new Set(['wallets', 'transfers']);

export function apiRouteOwner(path: string): 'wallet-core' | 'flow-core' | null {
  if (
    !path.startsWith('/') ||
    /[?#%\\]/.test(path) ||
    path.includes('//') ||
    path.split('/').some((s) => s === '.' || s === '..')
  )
    return null;
  const parts = path.split('/');
  if (parts[1] === 'app' && parts[2] === 'v1') return 'wallet-core';
  if (parts[1] === 'checkout' && parts[2] === 'v1') return 'flow-core';
  if (parts[1] !== 'v1') return null;
  if (flowCollections.has(parts[2])) return 'flow-core';
  if (walletCollections.has(parts[2])) return 'wallet-core';
  return null;
}

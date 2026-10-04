import profile from './arbitrum-sepolia-creation.json';
import { deploymentDocumentDigest } from './deployment';

const document = JSON.stringify(profile);
export const ARBITRUM_SEPOLIA_CREATION = Object.freeze({
  document,
  digest: deploymentDocumentDigest(document),
});
const deploymentDocument = JSON.stringify(profile.deployment);
export const ARBITRUM_SEPOLIA_DEPLOYMENT = Object.freeze({
  document: deploymentDocument,
  digest: deploymentDocumentDigest(deploymentDocument),
});

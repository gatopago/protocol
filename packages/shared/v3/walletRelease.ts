import profile from './arbitrum-sepolia-creation.json';
import { deploymentDocumentDigest } from './deployment';

// Public build inputs only. Neither API responses nor endpoint credentials can replace these pins.
const document = JSON.stringify(profile);
export const ARBITRUM_SEPOLIA_CREATION = Object.freeze({ document, digest: deploymentDocumentDigest(document) });
const deploymentDocument = JSON.stringify(profile.deployment);
export const ARBITRUM_SEPOLIA_DEPLOYMENT = Object.freeze({ document: deploymentDocument,
  digest: deploymentDocumentDigest(deploymentDocument) });

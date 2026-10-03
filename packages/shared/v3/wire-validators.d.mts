// Shape validation only; parsers must also enforce uint bounds, network and policy semantics.
export function validateTransferShape(value: unknown): boolean;
export function validateEnvironmentShape(value: unknown): boolean;
export function validateDeploymentShape(value: unknown): boolean;
export function validateCreationShape(value: unknown): boolean;

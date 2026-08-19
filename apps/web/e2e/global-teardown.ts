import { stopStack } from './global-setup';

export default function globalTeardown(): void {
  stopStack();
}

// ─────────────────────────────────────────────────────────────────────────────
// index.mjs — pick the provider driver.
//
// 'pi'   always uses the Pi session driver. It fails when Pi is not available.
// 'fake' always uses the deterministic test double.
// 'auto' uses Pi when it is installed, the account has credentials, and the
//        operator allowed spending. Otherwise it uses the test double and says
//        so in every record.
// ─────────────────────────────────────────────────────────────────────────────
import { FakeProvider } from './fake.mjs';
import { PiProvider, ProviderError } from './pi.mjs';

export { FakeProvider, PiProvider, ProviderError };

export async function createProvider({ config, logger = () => {} }) {
  const driver = config.provider.driver;
  if (driver === 'fake') {
    const provider = new FakeProvider({ config, logger });
    return { provider, detection: await provider.detect(), substituted: false };
  }

  const pi = new PiProvider({ config, logger });
  const detection = await pi.detect();

  if (driver === 'pi') {
    if (!detection.available) {
      throw new ProviderError('provider_unavailable', `The Pi command is not available: ${config.provider.command}`, detection);
    }
    if (!detection.credentialsPresent) {
      throw new ProviderError('provider_unavailable', 'The Pi account has no stored credentials', detection);
    }
    if (!detection.allowSpend) {
      throw new ProviderError('spend_not_allowed', 'Set PHYGEN_ALLOW_SPEND=1 to permit real model calls', detection);
    }
    return { provider: pi, detection, substituted: false };
  }

  const usable = detection.available && detection.credentialsPresent && detection.allowSpend;
  if (usable) return { provider: pi, detection, substituted: false };

  const fake = new FakeProvider({ config, logger });
  logger('warn', `The Pi driver is not usable (${describeReason(detection)}). Using the deterministic test double.`);
  return { provider: fake, detection: { ...(await fake.detect()), pi: detection, substituted: true }, substituted: true };
}

function describeReason(detection) {
  if (!detection.available) return 'the command was not found';
  if (!detection.credentialsPresent) return 'no credentials are stored';
  if (!detection.allowSpend) return 'spending is not allowed';
  return 'unknown';
}

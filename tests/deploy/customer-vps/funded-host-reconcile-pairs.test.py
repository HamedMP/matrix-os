"""Reconcile is production-only: preview and mixed funded pairs are refused before any request."""
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
NS = {'__name__': 'reconcile_pairs_test'}
for part in ('install.py', 'reconcile.py'):
    exec(compile((ROOT / 'distro/customer-vps/funded-host-config' / part).read_text(), part, 'exec'), NS)

PROD_RELAY = 'https://matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app'
PREVIEW_RELAY = 'https://matrix-ai-relay-preview-jqxkjdhtkq-ey.a.run.app'
PREVIEW_PLATFORM = 'https://metal-preview.matrix-os.com'


class ReconcilePairTests(unittest.TestCase):
    def test_accepts_empty_and_production_values(self):
        check = NS['require_production_funded_values']
        self.assertEqual(check({}), ('', ''))
        self.assertEqual(check({'MATRIX_FUNDED_AI_RELAY_URL': PROD_RELAY}), (PROD_RELAY, ''))
        check({'MATRIX_FUNDED_AI_RELAY_URL': PROD_RELAY, 'MATRIX_FUNDED_AI_PLATFORM_URL': 'https://app.matrix-os.com'})

    def test_refuses_preview_and_mixed_values(self):
        check = NS['require_production_funded_values']
        for values in ({'MATRIX_FUNDED_AI_RELAY_URL': PREVIEW_RELAY, 'MATRIX_FUNDED_AI_PLATFORM_URL': PREVIEW_PLATFORM},
                       {'MATRIX_FUNDED_AI_RELAY_URL': PREVIEW_RELAY, 'MATRIX_FUNDED_AI_PLATFORM_URL': 'https://app.matrix-os.com'},
                       {'MATRIX_FUNDED_AI_RELAY_URL': PROD_RELAY, 'MATRIX_FUNDED_AI_PLATFORM_URL': PREVIEW_PLATFORM},
                       {'MATRIX_FUNDED_AI_RELAY_URL': PREVIEW_RELAY},
                       {'MATRIX_FUNDED_AI_PLATFORM_URL': PREVIEW_PLATFORM}):
            with self.assertRaises(Exception):
                check(values)

    def test_refuses_a_preview_platform_response(self):
        identity = {'handle': 'alice', 'machineId': 'm', 'runtimeSlot': 'primary', 'runtimeTokenEpoch': 1}
        source = 'a' * 40
        def response(platform, relay):
            return {'contractVersion': 1, 'kind': 'matrix-funded-host-config', 'source': 'platform', 'sourceSha': source,
                    'issuedAt': '2026-11-22T12:00:00.000Z', 'expiresAt': '2026-11-22T12:00:30.000Z', 'identity': identity,
                    'configuration': {'MATRIX_FUNDED_AI_ENABLED': 'true', 'MATRIX_FUNDED_AI_RELAY_URL': relay,
                                      'MATRIX_FUNDED_AI_RUNTIME_TOKEN': 'c' * 64, 'MATRIX_FUNDED_AI_PLATFORM_URL': platform}}
        now = NS['timestamp']('2026-11-22T12:00:10.000Z')
        NS['validate_response'](response('https://app.matrix-os.com', PROD_RELAY), identity, source, now)
        for platform, relay in ((PREVIEW_PLATFORM, PREVIEW_RELAY), ('https://app.matrix-os.com', PREVIEW_RELAY), (PREVIEW_PLATFORM, PROD_RELAY)):
            with self.assertRaises(Exception):
                NS['validate_response'](response(platform, relay), identity, source, now)


if __name__ == '__main__':
    unittest.main()

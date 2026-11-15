"""Catch secret export, drift and invented bootstrap evidence at the real helper boundary."""
import copy, importlib.util, pathlib, tempfile, unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class ExportTests(unittest.TestCase):
    def test_private_export_is_exclusive_mode_0600_and_refuses_git_checkout(self):
        module = load('export-operator-state')
        with tempfile.TemporaryDirectory() as directory, patch.object(module, 'ROOT', pathlib.Path(directory)):
            module.store('private.json', {'metadata': 'private'})
            self.assertEqual((pathlib.Path(directory)/'private.json').stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError): module.store('private.json', {})
        with self.assertRaisesRegex(ValueError, 'outside Git'): module.store('must-not-exist.json', {})

    def source(self, worker=False):
        previous = load('test-source-disabled-config').SourceConfigurationTests()
        module = load('export-operator-state')
        source = previous.base(worker)
        config = {key: 'metadata-only' for key in module.base.FIELDS}
        config.update(MATRIX_PREVIEW_PAIR_ENABLED='false', MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED='false', MATRIX_PREVIEW_PAIR_CONTROLLER_SHA=module.PIN)
        source['template']['containers'][0]['env'] += [dict(name=k, value=v) for k,v in config.items()]
        source['template']['containers'][0]['env'] += [copy.deepcopy(module.base.OPERATOR), copy.deepcopy(module.reader.BINDING)]
        return source, config

    def test_exports_only_allowlisted_metadata_from_matching_disabled_services(self):
        module = load('export-operator-state')
        api, config = self.source(); worker, _ = self.source(True)
        api['template']['containers'][0]['env'].append(dict(name='UNRELATED_SECRET', value='DO_NOT_EXPORT'))
        result = module.extract_configuration(api, worker)
        self.assertEqual(result, config)
        self.assertNotIn('DO_NOT_EXPORT', str(result))
        self.assertNotIn('GITHUB_TOKEN', result)

    def test_rejects_active_missing_duplicate_or_drifted_configuration(self):
        module = load('export-operator-state')
        for fault in ['active', 'missing', 'duplicate', 'worker-drift', 'image', 'controller']:
            api, _ = self.source(); worker, _ = self.source(True)
            env = api['template']['containers'][0]['env']
            if fault == 'active': next(x for x in env if x['name']=='MATRIX_PREVIEW_PAIR_ENABLED')['value']='true'
            if fault == 'missing': env[:] = [x for x in env if x['name']!='MATRIX_PREVIEW_PAIR_FIXTURES']
            if fault == 'duplicate': env.append(copy.deepcopy(env[0]))
            if fault == 'worker-drift': next(x for x in worker['template']['containers'][0]['env'] if x['name']=='MATRIX_PREVIEW_PAIR_SOURCE_PROFILE')['value']='changed'
            if fault == 'image': api['template']['containers'][0]['image']='unreviewed'
            if fault == 'controller': next(x for x in env if x['name']=='MATRIX_PREVIEW_PAIR_CONTROLLER_SHA')['value']='0'*40
            with self.subTest(fault=fault), self.assertRaises(ValueError): module.extract_configuration(api, worker)

if __name__ == '__main__': unittest.main()

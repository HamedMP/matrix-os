"""Portable real-file missing-epoch atomicity and rollback contracts."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
def load(path):
    namespace = {'__name__': 'protected_epoch_test'}
    exec(compile((ROOT / path).read_text(), path, 'exec'), namespace)
    return namespace
REPAIR = type('Repair', (), load('scripts/ops/repair-funded-chat-config.py'))
EPOCH = load('distro/customer-vps/funded-host-config/install.py')
exec(compile((ROOT / 'distro/customer-vps/funded-host-config/reconcile.py').read_text(), 'reconcile.py', 'exec'), EPOCH)
# Load after these globals are present, just like the emitted self-contained code.
exec(compile((ROOT / 'distro/customer-vps/funded-host-config/epoch.py').read_text(), 'epoch.py', 'exec'), EPOCH)
class EpochTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = self.temp.name
        for part, mode in [('opt',0o755),('opt/matrix',0o770),('opt/matrix/env',0o750)]:
            os.mkdir(self.root+'/'+part,mode)
            os.chmod(self.root+'/'+part,mode)
        self.path=Path(self.root+'/opt/matrix/env/host.env')
        self.identity={'machineId':'12345678-1234-4234-9234-123456789012','ownerId':'user_test','handle':'test-main','runtimeSlot':'primary','epoch':2}
        self.old=('MATRIX_MACHINE_ID='+self.identity['machineId']+'\nMATRIX_CLERK_USER_ID=user_test\nMATRIX_HANDLE=test-main\nMATRIX_RUNTIME_SLOT=primary\nMATRIX_SYNC_RUNTIME_TOKEN='+'d'*64+'\nUNRELATED="$keep"\n').encode()
        self.path.write_bytes(self.old);os.chmod(self.path,0o640)
        self.anchor=REPAIR.open_environment(self.root,os.getuid(),os.getgid())
        self.config={'MATRIX_FUNDED_AI_ENABLED':'true','MATRIX_FUNDED_AI_RELAY_URL':'https://matrix-ai-relay-production-example-ey.a.run.app','MATRIX_FUNDED_AI_RUNTIME_TOKEN':'c'*64,'MATRIX_FUNDED_AI_PLATFORM_URL':'https://app.matrix-os.com'}
        self.id='epoch-'+'a'*32
    def tearDown(self):self.anchor.close();self.temp.cleanup()
    def apply(self, guard=lambda:None):
        info=self.path.stat()
        return EPOCH['apply_missing_epoch'](REPAIR,self.anchor,self.identity,self.config,self.id,self.old,info,guard,os.getuid(),os.getgid())
    def rollback(self):
        data=self.path.read_bytes();_,values,_=REPAIR.parse(data)
        return EPOCH['epoch_rollback_image'](REPAIR,self.anchor.fds[-1],REPAIR.backup_name(self.id),data,values,self.identity,os.getuid(),os.getgid(),self.path.stat())
    def test_metadata_proof_is_exact_owner_source_and_fresh_current_epoch(self):
        expected={'handle':'test-main','machineId':self.identity['machineId'],'ownerId':'user_test','runtimeSlot':'primary'}
        response={'contractVersion':1,'kind':'matrix-funded-host-epoch','source':'platform','sourceSha':'a'*40,
                  'issuedAt':'2026-10-09T00:00:00.000Z','expiresAt':'2026-10-09T00:00:30.000Z',
                  'identity':dict(expected,runtimeTokenEpoch=2)}
        self.assertEqual(EPOCH['validate_epoch_response'](response,expected,'a'*40,1791504001),2)
        for changed in (dict(response,sourceSha='b'*40),dict(response,configuration={}),
                        dict(response,expiresAt='2026-10-09T00:00:31.000Z'),
                        dict(response,identity=dict(response['identity'],ownerId='other')),
                        dict(response,identity=dict(response['identity'],runtimeTokenEpoch=True))):
            with self.assertRaises(Exception):EPOCH['validate_epoch_response'](changed,expected,'a'*40,1791504001)
        with self.assertRaises(Exception):EPOCH['validate_epoch_response'](response,expected,'a'*40,1791504031)

    def test_atomic_complete_image_and_exact_original_rollback(self):
        result=self.apply();after=self.path.read_bytes()
        self.assertTrue(result['changed']);self.assertIn(b'MATRIX_RUNTIME_TOKEN_EPOCH=2\n',after)
        for key,value in self.config.items():self.assertIn((key+'='+value+'\n').encode(),after)
        self.assertIn(b'UNRELATED="$keep"\n',after)
        self.assertEqual(self.rollback(),self.old)
        journal=json.loads(self.path.with_name(REPAIR.backup_name(self.id)).read_bytes())
        self.assertEqual(journal['version'],3)
        self.assertEqual(base64.b64decode(journal['original']),self.old)
    def test_refuses_present_or_duplicate_epoch_without_changes(self):
        for extra in (b'MATRIX_RUNTIME_TOKEN_EPOCH=1\n',b'MATRIX_RUNTIME_TOKEN_EPOCH=2\n',b'MATRIX_RUNTIME_TOKEN_EPOCH=2\nMATRIX_RUNTIME_TOKEN_EPOCH=2\n'):
            self.path.write_bytes(self.old+extra)
            with self.assertRaises(Exception):self.apply()
            self.assertEqual(self.path.read_bytes(),self.old+extra)
    def test_writer_or_cas_race_does_not_publish(self):
        def race():self.path.write_bytes(self.old+b'OTHER=changed\n')
        with self.assertRaises(Exception):self.apply(race)
        self.assertEqual(self.path.read_bytes(),self.old+b'OTHER=changed\n')
    def test_exclusive_journal_and_conflicting_token_refuse(self):
        self.apply()
        with self.assertRaises(Exception):self.apply()
        after=self.path.read_bytes();self.path.write_bytes(after.replace(b'c'*64,b'f'*64))
        with self.assertRaises(Exception):self.rollback()
    def test_rollback_refuses_changed_non_epoch_identity(self):
        self.apply();self.path.write_bytes(self.path.read_bytes().replace(b'MATRIX_HANDLE=test-main',b'MATRIX_HANDLE=other-main'))
        with self.assertRaises(Exception):self.rollback()

    def test_rollback_refuses_changed_sync_credential(self):
        self.apply();self.path.write_bytes(self.path.read_bytes().replace(b'd'*64,b'e'*64))
        with self.assertRaises(Exception):self.rollback()

    def test_rollback_preserves_unrelated_later_edit(self):
        self.apply();self.path.write_bytes(self.path.read_bytes()+b'LATER=preserved\n')
        self.assertEqual(self.rollback(),self.old+b'LATER=preserved\n')
    def test_oversized_rollback_preserves_readable_current_file(self):
        self.old += b'MATRIX_FUNDED_AI_RUNTIME_TOKEN='+b'a'*2048+b'\n'
        self.path.write_bytes(self.old)
        self.apply()
        current=self.path.read_bytes()
        current += b'FILL='+b'x'*(REPAIR.LIMIT-len(current)-6)+b'\n'
        self.assertEqual(len(current),REPAIR.LIMIT)
        self.path.write_bytes(current)
        info=self.path.stat()
        expected={'sha256':REPAIR.sha(current),'inode':info.st_ino,'device':info.st_dev}
        with self.assertRaises(Exception):
            EPOCH['execute_epoch_image'](REPAIR,self.anchor,self.identity,self.id,expected,lambda:None,None,os.getuid(),os.getgid())
        self.assertEqual(self.path.read_bytes(),current)
        self.assertEqual(len(self.path.read_bytes()),REPAIR.LIMIT)

    def test_preexisting_temporary_is_not_deleted_when_exclusive_create_fails(self):
        path=self.path.with_name('.host.env.funded.tmp-'+'b'*24)
        path.write_bytes(b'previous operation evidence')
        with patch.object(EPOCH['secrets'],'token_hex',return_value='b'*24),self.assertRaises(FileExistsError):
            self.apply()
        self.assertEqual(path.read_bytes(),b'previous operation evidence')
        self.assertEqual(self.path.read_bytes(),self.old)

    def test_rename_failure_keeps_original_and_journal(self):
        with patch.object(os,'replace',side_effect=OSError('injected failure')),self.assertRaises(OSError):self.apply()
        self.assertEqual(self.path.read_bytes(),self.old)
        self.assertTrue(self.path.with_name(REPAIR.backup_name(self.id)).exists())
    def test_symlink_rebinding_cannot_publish(self):
        def rebind():
            if not Path(self.root+'/original').exists():
                os.rename(self.path.parent,self.root+'/original');os.symlink(self.root+'/original',self.path.parent)
        with self.assertRaises(Exception):self.apply(rebind)
        self.assertEqual(Path(self.root+'/original/host.env').read_bytes(),self.old)
if __name__=='__main__':unittest.main()

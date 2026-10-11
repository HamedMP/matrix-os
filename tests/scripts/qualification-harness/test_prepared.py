import base64,hashlib,json,os
from pathlib import Path
import tempfile,unittest
from unittest.mock import patch
from fixtures import ROOT,inventory,SOURCE
import prepared
from common import digest,canonical

class PreparedCacheContracts(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name);self.image=self.root/'image';self.image.mkdir();self.work=self.root/'work';self.work.mkdir()
  self.store=self.image/'pnpm-store'/'v10';self.store.mkdir(parents=True);(self.store/'index').mkdir();(self.store/'files').mkdir()
  self.browsers=self.image/'browsers';self.browsers.mkdir()
  self.lock=b''
  for version,revision in [('1.58.2','1208'),('1.60.0','1234')]:
   package_hash=hashlib.sha512(version.encode()).digest();integrity='sha512-'+base64.b64encode(package_hash).decode();key=package_hash.hex()[:64]
   self.lock+=f'  playwright-core@{version}:\n    resolution: {{integrity: {integrity}}}\n'.encode()
   data=canonical({'browsers':[{'name':n,'revision':revision} for n in ('chromium','chromium-headless-shell','ffmpeg')]})
   content_hash=hashlib.sha512(data).digest();content_path=self.store/'files'/content_hash.hex()[:2]/content_hash.hex()[2:];content_path.parent.mkdir(exist_ok=True);content_path.write_bytes(data)
   index=self.store/'index'/key[:2]/(key[2:]+'-playwright-core@'+version+'.json');index.parent.mkdir(exist_ok=True)
   index.write_text(json.dumps({'name':'playwright-core','version':version,'files':{'browsers.json':{'integrity':'sha512-'+base64.b64encode(content_hash).decode(),'mode':420,'size':len(data)}}}))
   for name in ('chromium','chromium-headless-shell','ffmpeg'):
    p=self.browsers/(name.replace('-','_')+'-'+revision);p.mkdir();(p/'INSTALLATION_COMPLETE').touch()
  self.lockfile=self.work/'pnpm-lock.yaml';self.lockfile.write_bytes(self.lock);(self.image/'prepared-lock.sha256').write_text(digest(self.lock)+'\n')
  self.inv={'lockSha256':digest(self.lock)};self.destination=self.work/'pnpm-store'
  self.owner=patch.object(prepared,'IMAGE_UID',os.getuid());self.owner.start();self.addCleanup(self.owner.stop)
 def select(self):return prepared.select_cache(self.inv,self.lockfile,self.image,self.destination)
 def test_exact_trusted_lock_copies_content_store_and_selects_all_pinned_revisions(self):
  self.assertEqual(self.select(),'store-browsers');self.assertTrue((self.destination/'v10/files').is_dir())
  self.assertFalse((self.destination/'v10/links').exists())
  image=next((self.store/'files').glob('*/*'));copy=self.destination/'v10/files'/image.relative_to(self.store/'files')
  self.assertNotEqual(image.stat().st_ino,copy.stat().st_ino);copy.write_bytes(b'private');self.assertNotEqual(image.read_bytes(),b'private')
 def test_changed_image_pin_is_cold_without_copy(self):
  (self.image/'prepared-lock.sha256').write_text('f'*64+'\n');self.assertEqual(self.select(),'cold');self.assertFalse(self.destination.exists())
 def test_candidate_lock_alone_is_never_authority(self):
  self.inv['lockSha256']='f'*64
  with self.assertRaises(ValueError):self.select()
  self.assertFalse(self.destination.exists())
 def test_absent_pin_or_store_uses_cold_fallback(self):
  (self.image/'prepared-lock.sha256').unlink();self.assertEqual(self.select(),'cold')
  (self.image/'prepared-lock.sha256').write_text(digest(self.lock)+'\n');(self.store/'index').rename(self.store/'not-index');self.assertEqual(self.select(),'cold')
 def test_missing_one_expected_revision_keeps_store_but_downloads_browsers(self):
  (self.browsers/'chromium-1234/INSTALLATION_COMPLETE').unlink();self.assertEqual(self.select(),'store');self.assertTrue(self.destination.exists())
 def test_metadata_content_integrity_mismatch_never_reuses_browser(self):
  next((self.store/'files').glob('*/*')).write_bytes(b'{}');self.assertEqual(self.select(),'store')
 def test_unexpected_symlink_cache_is_cold(self):
  (self.image/'prepared-lock.sha256').unlink();(self.image/'prepared-lock.sha256').symlink_to(self.lockfile)
  self.assertEqual(self.select(),'cold')
 def test_symlink_revision_never_selects_readonly_browsers(self):
  path=self.browsers/'chromium-1234';path.rename(self.browsers/'elsewhere');path.symlink_to(self.browsers/'elsewhere',target_is_directory=True)
  self.assertEqual(self.select(),'store')
 def test_wrong_owner_never_reuses_image_content(self):
  with patch.object(prepared,'IMAGE_UID',os.getuid()+1):self.assertEqual(self.select(),'cold')
 def test_copy_failure_is_fatal_and_does_not_silently_mark_warm(self):
  self.destination.mkdir()
  with self.assertRaises(FileExistsError):self.select()
 def test_unknown_lock_shape_is_store_only(self):
  self.lockfile.write_bytes(b'unknown lock syntax');self.inv['lockSha256']=digest(self.lockfile.read_bytes());(self.image/'prepared-lock.sha256').write_text(self.inv['lockSha256']+'\n')
  self.assertEqual(self.select(),'store')
 def test_store_copy_preserves_executable_mode_and_rejects_symlinks(self):
  file=self.store/'files/tool-exec';file.write_bytes(b'bin');file.chmod(0o755)
  self.assertEqual(self.select(),'store-browsers');self.assertEqual((self.destination/'v10/files/tool-exec').stat().st_mode&0o777,0o755)
  import shutil
  shutil.rmtree(self.destination);file.unlink();file.symlink_to(self.lockfile)
  with self.assertRaises(ValueError):self.select()
 def test_store_copy_count_and_byte_caps_are_enforced(self):
  with patch.object(prepared,'MAX_STORE_ENTRIES',0):
   with self.assertRaises(ValueError):self.select()
  import shutil
  shutil.rmtree(self.destination)
  with patch.object(prepared,'MAX_STORE_BYTES',0):
   with self.assertRaises(ValueError):self.select()
 def test_revision_override_must_match_ubuntu24_x64(self):
  index=next((self.store/'index').glob('*/*'));package=json.loads(index.read_text());entry=package['files']['browsers.json'];hex_hash=prepared.sri(entry['integrity']).hex()
  old=self.store/'files'/hex_hash[:2]/hex_hash[2:];metadata=json.loads(old.read_text());metadata['browsers'][0]['revisionOverrides']={'ubuntu24.04-x64':'9999'}
  data=canonical(metadata);content_hash=hashlib.sha512(data).digest();p=self.store/'files'/content_hash.hex()[:2]/content_hash.hex()[2:];p.parent.mkdir(exist_ok=True);p.write_bytes(data)
  entry.update(integrity='sha512-'+base64.b64encode(content_hash).decode(),size=len(data));index.write_text(json.dumps(package))
  self.assertEqual(self.select(),'store')
 def test_replaced_manifest_digest_is_fatal_before_cache_selection(self):
  inv=inventory();p=self.work/'input.json';p.write_bytes(canonical(inv)+b'\n')
  with patch.object(prepared,'select_cache') as select:
   with self.assertRaises(ValueError):prepared.prepare(SOURCE,p,'0'*64,self.lockfile,self.image,self.destination)
   select.assert_not_called()

if __name__=='__main__':unittest.main()

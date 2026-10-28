import sys, os, pathlib, tempfile, unittest, subprocess, hashlib, json, importlib.util, shutil, fcntl
SCRIPT=pathlib.Path(sys.argv[1]).resolve()
spec=importlib.util.spec_from_file_location("hermes_artifact",SCRIPT);m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
PAYLOAD=b"fixture-only python member\n"
class Cases(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="eng306-publish-")
        self.base=pathlib.Path(self.temp.name).resolve();self.home=self.base/"home";self.source=self.home/".hermes/hermes-agent";self.source.mkdir(parents=True)
        self.owner=self.home/".hermes/config.yaml";self.owner.write_text("owner-fixture: preserve\n")
        (self.source/".gitignore").write_text("node_modules/\nui-tui/dist/\nhermes_cli/web_dist/\n")
        (self.source/"runtime.py").write_text("print('verified')\n")
        (self.source/"package-lock.json").write_text(json.dumps({"packages":{"node_modules/flatted":{"version":"3.4.4","integrity":"sha512-fixture"}}}))
        self.member=self.source/"node_modules/flatted/python/flatted.py";self.member.parent.mkdir(parents=True);self.member.write_bytes(PAYLOAD)
        (self.member.parent.parent/"package.json").write_text(json.dumps({"version":"3.4.4"}))
        for path in ["ui-tui/dist/entry.js","hermes_cli/web_dist/index.html"]:
            p=self.source/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text("compiled fixture product\n")
        self.git("init");self.git("add",".");self.git("-c","user.name=fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture")
        pin=self.git("rev-parse","HEAD").strip();self.policy=m.Policy(pin,hashlib.sha256(PAYLOAD).hexdigest(),len(PAYLOAD),"sha512-fixture")
        key=hashlib.sha256(str(self.source.resolve()).encode()).hexdigest()[:16]
        self.facts=self.source.parent/"installs"/key/"facts.json";self.facts.parent.mkdir(parents=True);self.facts.write_text('{"fixture":"committed-selection-unchanged"}')
        self.facts_before=self.facts.read_bytes()
    def tearDown(self): self.temp.cleanup()
    def git(self,*args):
        return subprocess.check_output(["/usr/bin/git","-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null","-C",str(self.source),*args],stderr=subprocess.DEVNULL,text=True,env={"PATH":"/usr/bin:/bin","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null","GIT_TERMINAL_PROMPT":"0"})
    def retained(self):
        self.assertEqual(self.owner.read_text(),"owner-fixture: preserve\n");self.assertEqual(self.facts.read_bytes(),self.facts_before)
    def test_publishes_whole_artifact_and_keeps_complete_original(self):
        result=m.publish(self.source,self.policy)
        self.assertFalse(self.member.exists());self.assertEqual((pathlib.Path(result["backup"])/"node_modules/flatted/python/flatted.py").read_bytes(),PAYLOAD)
        self.assertEqual((self.source/"runtime.py").read_text(),"print('verified')\n");self.retained()
    def test_repeat_setup_is_idempotent(self):
        first=m.publish(self.source,self.policy);second=m.publish(self.source,self.policy)
        self.assertIn("backup",first);self.assertEqual(first["backup"],second["backup"]);self.assertTrue(second["alreadyCurrent"]);self.retained()
    def test_wrong_member_hash_is_rejected_without_publication(self):
        self.member.write_bytes(b"unexpected")
        with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        self.assertEqual(self.member.read_bytes(),b"unexpected");self.retained()
    def test_tracked_source_change_is_rejected(self):
        (self.source/"runtime.py").write_text("print('untrusted')\n")
        with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        self.assertTrue(self.member.exists());self.retained()
    def test_other_ignored_import_code_is_not_accepted(self):
        (self.member.parent/"extra.py").write_text("raise RuntimeError('untrusted')\n")
        with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        self.assertTrue(self.member.exists());self.retained()
    def test_symlinked_member_is_rejected(self):
        other=self.base/"external.py";other.write_bytes(PAYLOAD);self.member.unlink();self.member.symlink_to(other)
        with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        self.assertTrue(self.member.is_symlink());self.retained()
    def test_missing_member_without_completed_receipt_is_rejected(self):
        self.member.unlink()
        with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        self.retained()
    def test_upstream_checkout_lock_prevents_publication(self):
        fd=os.open(self.source/".git/hermes-update.lock",os.O_RDWR|os.O_CREAT,0o600)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        finally:os.close(fd)
        self.assertTrue(self.member.exists());self.retained()
    def test_copy_race_preserves_changed_input(self):
        real=shutil.copytree
        def changed(*args,**kwargs):
            result=real(*args,**kwargs)
            if pathlib.Path(args[0])==self.source:(self.source/"runtime.py").write_text("changed during copy\n")
            return result
        m.shutil=shutil
        original=m.shutil.copytree;m.shutil.copytree=changed
        try:
            with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        finally:m.shutil.copytree=original
        self.assertEqual((self.source/"runtime.py").read_text(),"changed during copy\n");self.assertTrue(self.member.exists());self.retained()
    def test_second_rename_failure_restores_original_source(self):
        real=os.rename
        def failed(src,dst,*args,**kwargs):
            if pathlib.Path(dst)==self.source and pathlib.Path(src).parent.name.startswith("stage-"):raise OSError("injected publication failure")
            return real(src,dst,*args,**kwargs)
        m.os=os;original=m.os.rename;m.os.rename=failed
        try:
            with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        finally:m.os.rename=original
        self.assertEqual(self.member.read_bytes(),PAYLOAD);self.retained()
    def test_real_process_death_after_backup_can_be_recovered(self):
        pid=os.fork()
        if pid==0:
            real=m.os.rename
            def killed(src,dst,*args,**kwargs):
                value=real(src,dst,*args,**kwargs)
                if pathlib.Path(src)==self.source:os._exit(87)
                return value
            m.os.rename=killed
            try:m.publish(self.source,self.policy)
            finally:os._exit(88)
        _,status=os.waitpid(pid,0);self.assertEqual(os.waitstatus_to_exitcode(status),87)
        self.assertFalse(self.source.exists());result=m.recover(self.source);self.assertTrue(result["recovered"])
        self.assertEqual(self.member.read_bytes(),PAYLOAD);self.retained()
    def test_git_index_lock_is_not_copied_into_runtime(self):
        (self.source/".git/index.lock").write_text("another git writer")
        with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        self.assertTrue(self.member.exists());self.retained()
    def test_pm_selection_change_during_copy_is_preserved(self):
        real=shutil.copytree
        def changed(*args,**kwargs):
            result=real(*args,**kwargs)
            if pathlib.Path(args[0])==self.source:self.facts.write_text('{"external-actor":"updated"}')
            return result
        original=m.shutil.copytree;m.shutil.copytree=changed
        try:
            with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        finally:m.shutil.copytree=original
        self.assertEqual(self.facts.read_text(),'{"external-actor":"updated"}');self.assertTrue(self.member.exists())
    def test_source_alias_is_not_a_publication_target(self):
        alias=self.base/"alias";alias.mkdir();(alias/"hermes-agent").symlink_to(self.source,target_is_directory=True)
        with self.assertRaises(m.ArtifactError):m.publish(alias/"hermes-agent",self.policy)
        self.assertTrue(self.member.exists());self.retained()
    def test_escaping_dependency_link_is_rejected(self):
        outside=self.base/"external.js";outside.write_text("preserve")
        (self.source/"node_modules/escape.js").symlink_to(outside)
        with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        self.assertEqual(outside.read_text(),"preserve");self.assertTrue(self.member.exists());self.retained()
    def test_receipt_does_not_hide_later_owner_source_addition(self):
        m.publish(self.source,self.policy);(self.source/"owner-added.py").write_text("preserve this change")
        with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        self.assertEqual((self.source/"owner-added.py").read_text(),"preserve this change");self.retained()
    def test_insufficient_rollback_space_leaves_source_intact(self):
        original=m.shutil.disk_usage;values=original(self.source)
        m.shutil.disk_usage=lambda path:type(values)(values.total,values.used,0)
        try:
            with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        finally:m.shutil.disk_usage=original
        self.assertTrue(self.member.exists());self.retained()
    def test_space_budget_counts_git_metadata_and_filesystem_allocation(self):
        (self.source/".git/retained-fixture-object").write_bytes(b"x"*65536)
        payload=m._snapshot(self.source)[2]
        original=m.shutil.disk_usage;values=original(self.source)
        old_estimate=2*payload+int(4.5*1024**3)
        m.shutil.disk_usage=lambda path:type(values)(values.total,values.used,old_estimate+1)
        try:
            with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        finally:m.shutil.disk_usage=original
        self.assertTrue(self.member.exists());self.retained()
    def crash_after_candidate(self):
        pid=os.fork()
        if pid==0:
            real=m.os.rename
            def killed(src,dst,*args,**kwargs):
                value=real(src,dst,*args,**kwargs)
                if pathlib.Path(dst)==self.source and pathlib.Path(src).parent.name.startswith("stage-"):os._exit(89)
                return value
            m.os.rename=killed
            try:m.publish(self.source,self.policy)
            finally:os._exit(90)
        _,status=os.waitpid(pid,0);self.assertEqual(os.waitstatus_to_exitcode(status),89)
    def test_real_process_death_after_install_is_completed_safely(self):
        self.crash_after_candidate();self.assertFalse(self.member.exists())
        result=m.recover(self.source);self.assertTrue(result.get("committed"));self.assertFalse(self.member.exists());self.retained()
    def test_recovery_refuses_later_owner_changes(self):
        self.crash_after_candidate();(self.source/"runtime.py").write_text("later owner change")
        with self.assertRaises(m.ArtifactError):m.recover(self.source)
        self.assertEqual((self.source/"runtime.py").read_text(),"later owner change");self.retained()
    def test_git_directory_alias_is_rejected_before_any_external_lock_write(self):
        actual=self.base/"external-git";os.rename(self.source/".git",actual);(self.source/".git").symlink_to(actual,target_is_directory=True)
        with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        self.assertFalse((actual/"hermes-update.lock").exists());self.assertTrue(self.member.exists());self.retained()
    def test_state_alias_is_rejected_without_outside_writes(self):
        actual=self.base/"external-state";actual.mkdir();(self.source.parent/".matrix-runtime-artifacts").symlink_to(actual,target_is_directory=True)
        with self.assertRaises(m.ArtifactError):m.publish(self.source,self.policy)
        self.assertEqual(list(actual.iterdir()),[]);self.assertTrue(self.member.exists());self.retained()
if __name__=="__main__":
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(Cases);result=unittest.TextTestRunner(verbosity=2).run(suite)
    print("ARTIFACT_TEST_RESULT:"+json.dumps({"testsRun":result.testsRun,"failures":len(result.failures),"errors":len(result.errors)}))
    raise SystemExit(0 if result.wasSuccessful() else 1)

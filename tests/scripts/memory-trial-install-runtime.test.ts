import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const runtime = resolve("scripts/memory-trial/install-runtime.sh");
const receipts = resolve("scripts/memory-trial/receipts.py");
function shell(operation: string) {
  return execFileSync("bash", ["-c", 'set -eu; source "$1"; ' + operation, "trial-test", runtime], {timeout:10000, encoding:"utf8"}).trim();
}
function publish(operation: string) {
  return JSON.parse(execFileSync("python3", ["-B", "-c", `import importlib.util,json,os,pathlib,subprocess,sys,tempfile\ns=importlib.util.spec_from_file_location('receipts',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nwith tempfile.TemporaryDirectory() as tmp:\n root=pathlib.Path(tmp);p=root/'synthetic.txt';p.write_text('previous');os.chmod(p,0o640)\n ${operation.replaceAll("\n", "\n ")}`, receipts], {timeout:10000, encoding:"utf8"}));
}
describe("private memory installer runtime", () => {
  it("serializes the entire package installation phase", () => {
    expect(shell('trial_root=$(mktemp -d); trap \'rm -rf "$trial_root"\' EXIT; trial_lock_install "$trial_root"; if bash -c \'source "$1"; trial_lock_install "$2"\' trial-child "$1" "$trial_root"; then exit 1; fi; echo locked')).toBe("locked");
  });
  it("refuses package changes while either trial engine is running", () => {
    expect(shell('timeout(){ shift; "$@"; }; systemctl(){ if [[ "$*" == *openviking* ]]; then echo active; return 0; fi; echo inactive; return 3; }; if trial_require_stopped; then exit 1; fi; echo refused')).toBe("refused");
  });
  it("allows package installation when both trial services are stopped", () => {
    expect(shell('timeout(){ shift; "$@"; }; systemctl(){ echo inactive; return 3; }; trial_require_stopped; echo stopped')).toBe("stopped");
  });
  it("fails closed when service inspection times out", () => {
    expect(shell('timeout(){ return 124; }; if trial_require_stopped; then exit 1; fi; echo refused')).toBe("refused");
  });
  it("refuses a restarting engine even when is-active returns a nonzero code", () => {
    expect(shell('timeout(){ shift; "$@"; }; systemctl(){ echo activating; return 3; }; if trial_require_stopped; then exit 1; fi; echo refused')).toBe("refused");
  });
  it("preserves the published receipt when a producer fails", () => {
    expect(publish(`failed=False\ntry: m.publish_receipt(p,[sys.executable,'-c',"print('partial');raise SystemExit(1)"])\nexcept subprocess.CalledProcessError: failed=True\nprint(json.dumps({'failed':failed,'preserved':p.read_text()=='previous','stagingCleared':not (root/'.synthetic.txt.pending').exists()}))`)).toEqual({failed:true,preserved:true,stagingCleared:true});
  });
  it("publishes a complete receipt by replacement and cleans abandoned staging", () => {
    expect(publish(`staged=root/'.synthetic.txt.pending';staged.write_text('interrupted');os.chmod(staged,0o600)\nold=p.stat().st_ino\nm.publish_receipt(p,[sys.executable,'-c',"print('synthetic==1')"])\nprint(json.dumps({'complete':p.read_text()=='synthetic==1\\n','replaced':p.stat().st_ino!=old,'mode':oct(p.stat().st_mode&0o777),'stagingCleared':not staged.exists()}))`)).toEqual({complete:true,replaced:true,mode:"0o640",stagingCleared:true});
  });
  it("never follows a receipt staging symlink", () => {
    expect(publish(`other=root/'preserve';other.write_text('safe');(root/'.synthetic.txt.pending').symlink_to(other)\nfailed=False\ntry: m.publish_receipt(p,[sys.executable,'-c',"print('new')"])\nexcept (ValueError,OSError): failed=True\nprint(json.dumps({'failed':failed,'preserved':p.read_text()=='previous','unrelatedPreserved':other.read_text()=='safe'}))`)).toEqual({failed:true,preserved:true,unrelatedPreserved:true});
  });
  it("rejects an oversized producer receipt without truncating prior state", () => {
    expect(publish(`failed=False\ntry: m.publish_receipt(p,[sys.executable,'-c',"print('x'*262145)"])\nexcept ValueError: failed=True\nprint(json.dumps({'failed':failed,'preserved':p.read_text()=='previous','stagingCleared':not (root/'.synthetic.txt.pending').exists()}))`)).toEqual({failed:true,preserved:true,stagingCleared:true});
  });
  it("always compares protected configuration before installing packages", () => {
    const install=readFileSync(resolve("scripts/memory-trial/install.sh"),"utf8");
    expect(install).not.toContain('if [[ ! -f /etc/matrix/memory-trial/hindsight.env');
    expect(install.indexOf("trial_lock_install")).toBeLessThan(install.indexOf("configure.py"));
    expect(install.indexOf("trial_require_stopped")).toBeLessThan(install.indexOf("-m pip install"));
    expect(install).not.toMatch(/pip freeze\s*>/);
  });
});

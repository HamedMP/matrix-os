import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(denied: "" | "visudo" | "runuser" = "") {
  const root = await mkdtemp("/tmp/matrix-golden-sudoers-");
  roots.push(root);
  const commands = join(root, "commands");
  await mkdir(commands);
  const customer = await readFile("distro/customer-vps/cloud-init.yaml", "utf8");
  const policy = customer.match(/printf '([^']+)' >\/etc\/sudoers\.d\/matrix/)?.[1].replace(/\\n/g, "\n");
  if (!policy) throw new Error("Customer sudo policy missing");
  const source = await readFile("distro/customer-vps/host-bin/matrix-golden-snapshot-activate", "utf8");
  const start = source.indexOf("set_activation_stage activation_runtime_setup\n");
  const end = source.indexOf("terminal_activation_marker=", start);
  if (start < 0 || end < start) throw new Error("Activation setup boundary missing");
  // Execute the real setup producer. Only absolute filesystem roots and the
  // privileged OS commands are fixtures; Linux native QA must prove real sudo.
  let setup = source.slice(start, end);
  for (const path of ["/etc/sudoers.d", "/opt/matrix", "/home/matrix", "/var/lib/matrix"]) {
    setup = setup.replaceAll(path, `${root}${path}`);
  }
  for (const command of ["getent", "id", "groupadd", "useradd", "install", "visudo", "runuser"]) {
    await writeFile(join(commands, command), `#!${process.execPath}
const {execFileSync}=require("node:child_process");
const {readFileSync,statSync,writeFileSync,existsSync}=require("node:fs");
const command=${JSON.stringify(command)}, root=process.env.QA_FIXTURE_ROOT;
const args=process.argv.slice(2), policy=root+"/etc/sudoers.d/matrix";
if(command==="getent"||command==="id")process.exit(0);
if(command==="install"){
  const forwarded=[];
  for(let i=0;i<args.length;i++){
    if(args[i]==="-o"||args[i]==="-g"){i++;continue;}
    if(args[i].startsWith("/")&&!args[i].startsWith(root+"/"))process.exit(90);
    forwarded.push(args[i]);
  }
  execFileSync("/usr/bin/install",forwarded);process.exit(0);
}
if(command==="visudo"){
  if(process.env.QA_DENIED==="visudo")process.exit(42);
  if(args.join(" ")!=="-cf "+policy||readFileSync(policy,"utf8")!==process.env.QA_EXPECTED_POLICY||(statSync(policy).mode&0o777)!==0o440)process.exit(91);
  writeFileSync(root+"/validated","yes");process.exit(0);
}
if(command==="runuser"){
  if(process.env.QA_DENIED==="runuser")process.exit(43);
  if(args.join(" ")!=="-u matrix -- sudo -n /usr/bin/true"||!existsSync(root+"/validated"))process.exit(92);
  writeFileSync(root+"/admitted","yes");process.exit(0);
}
process.exit(93);
`, { mode: 0o755 });
  }
  const run = () => execFileAsync("bash", ["-c", `set -euo pipefail\nset_activation_stage(){ :; }\n${setup}\nprintf ready > "$QA_FIXTURE_ROOT/ready"`], {
    env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, QA_FIXTURE_ROOT: root, QA_DENIED: denied, QA_EXPECTED_POLICY: policy },
    timeout: 10_000,
  });
  return { root, policy, run };
}

it("gives synthetic services the validated customer sudo policy before activation", async () => {
  const test = await fixture();
  await test.run();
  const path = join(test.root, "etc/sudoers.d/matrix");
  const metadata = await stat(path).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  expect(metadata, "activation must produce the policy required by the sync agent").not.toBeNull();
  expect(metadata!.mode & 0o777).toBe(0o440);
  expect(await readFile(path, "utf8")).toBe(test.policy);
  expect(await readFile(join(test.root, "admitted"), "utf8")).toBe("yes");
});

it.each(["visudo", "runuser"] as const)("stops activation when %s rejects the service privilege setup", async denied => {
  const test = await fixture(denied);
  await expect(test.run()).rejects.toMatchObject({ code: denied === "visudo" ? 42 : 43 });
  await expect(stat(join(test.root, "ready"))).rejects.toMatchObject({ code: "ENOENT" });
});

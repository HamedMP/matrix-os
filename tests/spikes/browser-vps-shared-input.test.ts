import { describe,expect,it,vi } from "vitest";
import { createSupervisor } from "../../scripts/spikes/browser-vps/supervisor.mjs";

describe("fixed shared Chrome input gate",()=>{
  it("acknowledges disabled human input without starting a comparison worker",async()=>{
    const spawn=vi.fn();const gate=vi.fn(async()=>{});
    const supervisor=createSupervisor({spawn,terminate:vi.fn(),setHumanControl:gate});
    const state=await supervisor.automationInput(false);
    expect(state.humanControlAvailable).toBe(false);expect(gate).toHaveBeenLastCalledWith(false);expect(spawn).not.toHaveBeenCalled();
    expect((await supervisor.automationInput(true)).humanControlAvailable).toBe(true);await supervisor.close();
  });
  it("rejects invalid input without widening the gate",async()=>{
    const gate=vi.fn(async()=>{});const supervisor=createSupervisor({spawn:vi.fn(),terminate:vi.fn(),setHumanControl:gate});
    await expect(supervisor.automationInput("true" as never)).rejects.toThrow();expect(gate).not.toHaveBeenCalled();await supervisor.close();
  });
  it("observes a presentation without changing its automation input state",async()=>{
    const gate=vi.fn(async()=>{});const supervisor=createSupervisor({spawn:vi.fn(),terminate:vi.fn(),setHumanControl:gate});
    await supervisor.automationInput(false);const count=gate.mock.calls.length;
    expect(await supervisor.observe(async()=>"visible")).toBe("visible");expect(gate).toHaveBeenCalledTimes(count);
    expect(supervisor.status().humanControlAvailable).toBe(false);await supervisor.close();
  });
});

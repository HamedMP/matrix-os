import { wireKernel } from "../../../desktop/src/renderer/src/lib/kernel-wiring";
import { useConnection } from "../../../desktop/src/renderer/src/stores/connection";
useConnection.setState({ status: "signed-in", platformHost: location.origin, runtimeSlot: "primary", authGeneration: 1 });
wireKernel();
document.title = "App bridge shell ready";

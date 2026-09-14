import "@/lib/hermes-polyfills";
import { SignInScreen } from "@/components/auth/SignInScreen";

// The "/" index route renders this same screen directly when logged out;
// this standalone route stays reachable for post-sign-out router.replace
// calls elsewhere in the app (settings, computers, chat).
export default SignInScreen;

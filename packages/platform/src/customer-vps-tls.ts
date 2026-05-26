export function shouldVerifyCustomerVpsTls(env: Record<string, string | undefined> = process.env): boolean {
  return env.CUSTOMER_VPS_TLS_VERIFY !== 'false';
}

/**
 * Wording every owner Share control uses when the account has no active
 * organization. Sharing exists only inside an organization (S20 / T101), so a
 * control names what is missing instead of failing silently: the project row
 * shows it as its label, and the compact terminal and resource controls
 * (which also sit in the mobile terminal chrome) explain it when activated.
 */
export const ORGANIZATION_REQUIRED_SHARE_LABEL = "Join an organization to share";

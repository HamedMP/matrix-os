// Ensure git has a committer identity even when the host lacks global config
// (e.g. ephemeral CI runners, fresh containers). Overridable via env.
export const GIT_ENV = {
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Matrix OS",
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "matrix-os@users.noreply.github.com",
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Matrix OS",
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "matrix-os@users.noreply.github.com",
};

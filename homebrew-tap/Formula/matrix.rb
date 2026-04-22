# Homebrew formula for the Matrix OS CLI.
#
# Lives here for version control during bootstrap; the CI release workflow
# mirrors it into the matrix-os/homebrew-tap repository and bumps url/sha256
# on each tag push.
#
# Install: brew install matrix-os/tap/matrix

class Matrix < Formula
  desc "Matrix OS command-line client (sync, login, peer management)"
  homepage "https://matrix-os.com"

  # `url` and `sha256` are rewritten by .github/workflows/release.yml against
  # the npm tarball after each publish. Keep them valid for `brew install` to
  # work off main while the release pipeline sleeps.
  url "https://registry.npmjs.org/@matrix-os/cli/-/cli-0.2.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  version "0.2.0"

  license "AGPL-3.0-or-later"

  depends_on "node@24"

  def install
    # Install the package into libexec, then symlink the bins into HOMEBREW_PREFIX/bin.
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # `matrix --version` exits with the version from package.json.
    output = shell_output("#{bin}/matrix --version")
    assert_match version.to_s, output
  end
end

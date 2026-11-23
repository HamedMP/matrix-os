# Homebrew formula for the Matrix OS CLI.
#
# This is the source of truth. The CLI Release workflow copies it into the
# FinnaAI/homebrew-tap repository and sets url/sha256/version on each release.
#
# Install: brew install finnaai/tap/matrix

class Matrix < Formula
  desc "Matrix OS command-line client (sync, login, peer management)"
  homepage "https://matrix-os.com"

  # `url`, `sha256`, and `version` are rewritten by
  # .github/workflows/cli-release.yml against the npm tarball after each
  # publish. Until the first release job rewrites this staging copy, the
  # placeholder sha256 is intentionally non-installable.
  #
  # `:nounzip` keeps the published tarball intact for `install` below.
  url "https://registry.npmjs.org/@finnaai/matrix/-/matrix-0.2.0.tgz", using: :nounzip
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  version "0.2.0"

  license "AGPL-3.0-or-later"

  depends_on "node@20"

  def install
    # Install the published tarball itself. Homebrew's `std_npm_args` first
    # repacks the unpacked sources with `npm pack`, and that drops the
    # `@matrix-os/contracts` files the tarball ships under `node_modules`
    # (they are deliberately not declared as bundled dependencies, because npm
    # mishandles those on a global install). The CLI then fails to start.
    tarball = buildpath.children.find { |path| path.extname == ".tgz" }
    odie "published tarball not found in #{buildpath}" if tarball.nil?
    (libexec/"lib").mkpath
    system "npm", "install", "--global", "--ignore-scripts", "--prefix=#{libexec}", tarball
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # `matrix --version` exits with the version from package.json.
    output = shell_output("#{bin}/matrix --version")
    assert_match version.to_s, output
  end
end

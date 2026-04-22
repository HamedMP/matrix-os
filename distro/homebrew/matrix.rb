# Homebrew formula for the Matrix OS CLI.
#
# This file lives in this repo as a template. The published copy belongs in
# the tap repo at https://github.com/finnaai/homebrew-tap under `Formula/matrix.rb`.
#
# The release workflow (.github/workflows/release-cli.yml) auto-bumps the
# `url` and `sha256` in the tap copy when a new `v*` tag is pushed.

class Matrix < Formula
  desc "Matrix OS CLI — file sync, sharing, and remote access"
  homepage "https://matrix-os.com"
  url "https://github.com/hamedmp/matrix-os/releases/download/v0.9.0/matrix-cli-0.9.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "AGPL-3.0-or-later"
  version "0.9.0"

  depends_on "node@20"

  def install
    libexec.install Dir["*"]
    %w[matrix matrixos mos].each do |alias_name|
      bin.install_symlink libexec/"bin/#{alias_name}"
    end
  end

  test do
    assert_match(/\d+\.\d+\.\d+/, shell_output("#{bin}/matrix --version"))
  end
end

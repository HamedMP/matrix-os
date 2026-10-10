# UTF-8 locale for the Linux benchmark image

Native Chromium must receive `LANG=C.UTF-8` and `LC_ALL=C.UTF-8` from the
benchmark image. Ubuntu provides this locale without additional packages.

On the eight-core Linux host, the unchanged mixed file-drop regression exposed
only three of four dragged files before application handling: the Unicode-named
text fixture was missing with an unset locale. All three upload requests that
reached the application succeeded. Repeating the original suite with only the
two locale variables set passed all five Linux cases; two macOS-only cases
remained skipped. The filename, uploaded bytes, extension, bracketed-paste and
ordering assertions, and all test timeouts, remain unchanged.

The controlled reproduction used source
`dfea1bab17cce6b05c6b0484598e40d87bcf4bdf`, image
`sha256:8dde76cfefcb1f1b7a5bbab549400441667f31d3fee0597b46c627fc790d283b`,
one Vitest worker, and an eight-CPU/28-GiB disposable container. The failing run
took 6.89 seconds in Vitest; the passing run took 5.52 seconds (97 seconds
including checkout, installation and Desktop build). This is a focused
compatibility result, not a whole-CI speedup or five-minute acceptance proof.

Validation: image locale contract fails before the environment change and passes
afterward; rebuild the image and rerun the required Electron lane before rollout.
No customer runtime, credentials, test assertions or hosted workflow changes.

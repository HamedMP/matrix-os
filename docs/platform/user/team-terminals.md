# Team terminals

Share one live terminal with people in your organization, so you can watch
it, type in it and prompt an agent in it together. Spec:
[2710 team terminals](../../../specs/2710-team-terminals/spec.md).

## Share a terminal

1. In the Terminal window (Electron Desktop), open a terminal on one of your
   Matrix computers.
2. Click the share button in the pane header.
3. Read the warning. **A shared terminal is full shell access.** Everyone you
   add sees everything it prints, including secrets. Editors can type and run
   any command as you on that computer. Share terminals on a team computer,
   not a personal one.
4. Choose the computer name teammates see, then **Share terminal**.
5. Add everyone in the organization or one person at a time, as **Viewer**
   (watch only) or **Editor** (can type).

Terminals on this Mac and on machines added over ssh cannot be shared.

## Open a terminal someone shared with you

Shared terminals appear in the Terminal window's sidebar under **Team**,
under the computer they run on ("Nima's team-dev-1"). Click one to open it.
A share you have not opened yet says **Open to join**; opening it joins.

Nothing appears unless the owner shared it with you. Membership in the
organization alone shows nothing.

## Working together

- The pane header shows who is in the terminal; a blue ring means that person
  is typing. It also shows who pressed Enter last.
- Editors type together: keystrokes reach the terminal in the order they
  arrive. To avoid typing over each other, say who is driving, or let the
  owner take control.
- Viewers see **View only**. The owner's computer refuses their input.
- Matrix shows who typed, never what they typed: it keeps no recording of
  keystrokes.

## Take control and stop sharing

- The owner clicks **Take control** to pause everyone else's typing, and
  **Hand back** to let editors type again.
- **Stop sharing** (in the Share dialog) removes every person's access. Their
  panes close at once; the program keeps running for the owner.
- Changing someone to Viewer stops their typing on their next keystroke.
  Removing someone from the organization ends their access within about 25
  seconds.

## Where it works

Team terminals are in the Electron Desktop Terminal window. Web Desktop, Web
Canvas and the mobile apps do not show them yet.

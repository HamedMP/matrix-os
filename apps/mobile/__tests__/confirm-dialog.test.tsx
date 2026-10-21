import { fireEvent, render, screen } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { Modal } from "react-native";

import { ConfirmDialog, type ConfirmDialogProps } from "../components/ui/ConfirmDialog";

function renderDialog(props: Partial<ConfirmDialogProps> = {}) {
  const onCancel = jest.fn();
  const onConfirm = jest.fn();
  const view = render(
    <ConfirmDialog
      visible
      title="Delete connection?"
      message="This revokes Matrix access to amin@example.com in GitHub."
      confirmLabel="Delete"
      confirmAccessibilityLabel="Confirm delete connection"
      dismissAccessibilityLabel="Close delete connection popup"
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { ...view, onCancel, onConfirm };
}

describe("ConfirmDialog", () => {
  beforeEach(() => {
    jest.mocked(Haptics.notificationAsync).mockClear();
  });

  it("asks with a title, the consequence, Cancel and the action, over the screen", () => {
    renderDialog();

    expect(screen.UNSAFE_getByType(Modal).props).toMatchObject({ visible: true, transparent: true, animationType: "fade" });
    expect(screen.getByText("Delete connection?")).toBeTruthy();
    expect(screen.getByText("This revokes Matrix access to amin@example.com in GitHub.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm delete connection" })).toBeTruthy();
  });

  it("confirms with the action, and cancels with Cancel, the backdrop or the system back", () => {
    const { onCancel, onConfirm } = renderDialog();

    fireEvent.press(screen.getByRole("button", { name: "Confirm delete connection" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.press(screen.getByLabelText("Close delete connection popup"));
    screen.UNSAFE_getByType(Modal).props.onRequestClose();
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it("plays the warning haptic as a destructive dialog opens, and not for one that is not", () => {
    const view = renderDialog({ destructive: true, visible: false });
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();

    view.rerender(
      <ConfirmDialog
        visible
        destructive
        title="Delete terminal session?"
        message="This can't be undone."
        confirmLabel="Delete"
        dismissAccessibilityLabel="Close terminal popup"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Warning);
    view.unmount();

    jest.mocked(Haptics.notificationAsync).mockClear();
    renderDialog({ destructive: false });
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it("waits while the action runs: both buttons are off and the backdrop does nothing", () => {
    const { onCancel, onConfirm } = renderDialog({ busy: true });

    for (const name of ["Cancel", "Confirm delete connection"]) {
      const button = screen.getByRole("button", { name });
      expect(button.props.accessibilityState).toMatchObject({ disabled: true });
      fireEvent.press(button);
    }
    fireEvent.press(screen.getByLabelText("Close delete connection popup"));
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows what went wrong under the message", () => {
    renderDialog({ error: "Could not delete connection. Try again." });

    expect(screen.getByText("Could not delete connection. Try again.").props.accessibilityRole).toBe("alert");
  });

  it("can hold a text field, such as a new name, that confirms from the keyboard too", () => {
    const onChangeText = jest.fn();
    const { onConfirm } = renderDialog({
      field: { accessibilityLabel: "Terminal session name", value: "build", onChangeText, maxLength: 64 },
    });

    const field = screen.getByLabelText("Terminal session name");
    expect(field.props).toMatchObject({ value: "build", maxLength: 64, autoFocus: true, returnKeyType: "done" });
    fireEvent.changeText(field, "build-2");
    expect(onChangeText).toHaveBeenCalledWith("build-2");
    fireEvent(field, "submitEditing");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

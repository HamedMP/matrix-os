import React from "react";
import { Alert, Pressable, Text } from "react-native";
import * as Clipboard from "expo-clipboard";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { ChatContextMenu } from "../components/ChatContextMenu";

afterEach(() => jest.restoreAllMocks());

it("copies the full Native Mobile chat ID after a long press without opening the chat", async () => {
  const alert = jest.spyOn(Alert, "alert");
  const select = jest.fn();
  render(<ChatContextMenu chatId="chat_native_full_id"><Pressable onPress={select}><Text>Native chat</Text></Pressable></ChatContextMenu>);
  fireEvent(screen.getByText("Native chat"), "longPress");
  const action = alert.mock.calls[0]?.[2]?.find((button) => button.text === "Copy chat ID");
  expect(action).toBeDefined();
  action!.onPress?.();
  await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith("chat_native_full_id"));
  expect(select).not.toHaveBeenCalled();
});

it("shows safe clipboard failure feedback and does not expose a draft ID", async () => {
  const alert = jest.spyOn(Alert, "alert");
  jest.spyOn(Clipboard, "setStringAsync").mockRejectedValueOnce(new Error("secret native failure"));
  const view = render(<ChatContextMenu><Pressable><Text>Draft chat</Text></Pressable></ChatContextMenu>);
  fireEvent(screen.getByText("Draft chat"), "longPress");
  expect(alert).not.toHaveBeenCalled();
  view.rerender(<ChatContextMenu chatId="chat_retry"><Pressable><Text>Draft chat</Text></Pressable></ChatContextMenu>);
  fireEvent(screen.getByText("Draft chat"), "longPress");
  alert.mock.calls[0]?.[2]?.find((button) => button.text === "Copy chat ID")?.onPress?.();
  await waitFor(() => expect(alert).toHaveBeenCalledWith("Could not copy chat ID", "Try again."));
  expect(JSON.stringify(alert.mock.calls)).not.toContain("secret native failure");
});

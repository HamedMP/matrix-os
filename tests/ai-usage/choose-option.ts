import { fireEvent, screen } from "@testing-library/react";
/** Exercise the real library combobox through keyboard events; jsdom lacks the browser scroll API. */
export function chooseOption(label: string, option: string) {
  if (!Element.prototype.scrollIntoView)
    Element.prototype.scrollIntoView = () => {};
  fireEvent.keyDown(screen.getByRole("combobox", { name: label }), {
    key: "ArrowDown",
  });
  fireEvent.keyDown(screen.getByRole("option", { name: option, exact: true }), {
    key: "Enter",
  });
}

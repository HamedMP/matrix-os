// @vitest-environment jsdom
import React from "react";
import {afterEach,expect,it} from "vitest";
import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {BotScheduledInputText} from "../../../shell/src/components/BotTranscriptState";
afterEach(cleanup);
it("collapses a long scheduled input in its existing Web message and expands once in place",()=>{
  const text="Read only. Return fixed acceptance text. ".repeat(20);
  render(<BotScheduledInputText text={text} scheduled/>);
  const body=screen.getByText(text.trim());
  expect(body.className).toContain("line-clamp-3");
  fireEvent.click(screen.getByRole("button",{name:"Show more"}));
  expect(screen.getAllByText(text.trim())).toHaveLength(1);expect(body.className).not.toContain("line-clamp-3");
});
it("preserves the ordinary manual message presentation",()=>{
  render(<BotScheduledInputText text={"Manual message. ".repeat(40)} scheduled={false}/>);
  expect(screen.queryByRole("button",{name:"Show more"})).toBeNull();
});

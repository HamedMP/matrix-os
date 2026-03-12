// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "../../packages/ui/src/Card";

describe("Card", () => {
  it("renders children", () => {
    render(<Card>Card content</Card>);
    expect(screen.getByText("Card content")).toBeTruthy();
  });

  it("applies matrix-card class", () => {
    const { container } = render(<Card>Content</Card>);
    expect(container.firstElementChild?.className).toContain("matrix-card");
  });

  it("applies glass variant", () => {
    const { container } = render(<Card glass>Glass card</Card>);
    expect(container.firstElementChild?.className).toContain("matrix-card-glass");
  });

  it("accepts custom className", () => {
    const { container } = render(<Card className="custom">Content</Card>);
    expect(container.firstElementChild?.className).toContain("custom");
  });

  it("accepts custom style", () => {
    const { container } = render(<Card style={{ maxWidth: "400px" }}>Content</Card>);
    expect((container.firstElementChild as HTMLElement).style.maxWidth).toBe("400px");
  });
});

describe("CardHeader", () => {
  it("renders children", () => {
    render(<CardHeader>Header</CardHeader>);
    expect(screen.getByText("Header")).toBeTruthy();
  });
});

describe("CardTitle", () => {
  it("renders as h3", () => {
    render(<CardTitle>Title</CardTitle>);
    const heading = screen.getByRole("heading", { level: 3 });
    expect(heading).toHaveTextContent("Title");
  });
});

describe("CardContent", () => {
  it("renders children", () => {
    render(<CardContent>Body content</CardContent>);
    expect(screen.getByText("Body content")).toBeTruthy();
  });
});

describe("CardFooter", () => {
  it("renders children", () => {
    render(<CardFooter>Footer actions</CardFooter>);
    expect(screen.getByText("Footer actions")).toBeTruthy();
  });
});

describe("Card composition", () => {
  it("renders full card with header, title, content, and footer", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>My Card</CardTitle>
        </CardHeader>
        <CardContent>The body</CardContent>
        <CardFooter>Actions</CardFooter>
      </Card>
    );
    expect(screen.getByRole("heading")).toHaveTextContent("My Card");
    expect(screen.getByText("The body")).toBeTruthy();
    expect(screen.getByText("Actions")).toBeTruthy();
  });
});

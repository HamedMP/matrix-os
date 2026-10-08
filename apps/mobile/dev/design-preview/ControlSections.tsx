import { Fragment, useState } from "react";
import { useUnistyles } from "react-native-unistyles";

import { SearchField } from "@/components/shell/Controls";
import {
  AddIcon,
  Button,
  Chip,
  ProviderLogo,
  TextField,
  type ButtonSize,
  type ButtonVariant,
  type Provider,
} from "@/components/ui";

import { PreviewCaption, PreviewRow, PreviewSection } from "./PreviewSection";

const VARIANTS: { variant: ButtonVariant; label: string }[] = [
  { variant: "filled", label: "Allow once" },
  { variant: "outline", label: "Open" },
  { variant: "secondary", label: "New agent" },
  { variant: "text", label: "Cancel" },
];
const SIZES: { size: ButtonSize; caption: string }[] = [
  { size: "default", caption: "Default, 44 high" },
  { size: "large", caption: "Large, 48 high" },
];
const CATEGORIES = ["All", "Personal", "Sales", "Marketing", "Ops"];
const ENGINES: { provider: Provider; label: string }[] = [
  { provider: "matrix", label: "Matrix AI" },
  { provider: "claude", label: "Claude Code" },
  { provider: "codex", label: "Codex" },
  { provider: "hermes", label: "Hermes" },
  { provider: "openclaw", label: "OpenClaw" },
  { provider: "opencode", label: "OpenCode" },
  { provider: "pi", label: "Pi" },
];

function noop() {}

export function ButtonsSection() {
  return (
    <PreviewSection title="Buttons">
      {SIZES.map(({ size, caption }) => (
        <Fragment key={size}>
          <PreviewCaption>{caption}</PreviewCaption>
          <PreviewRow>
            {VARIANTS.map(({ variant, label }) => (
              <Button key={variant} variant={variant} size={size} label={label} onPress={noop} />
            ))}
          </PreviewRow>
        </Fragment>
      ))}
      <PreviewCaption>With an icon</PreviewCaption>
      <PreviewRow>
        {VARIANTS.map(({ variant, label }) => (
          <Button key={variant} variant={variant} icon={AddIcon} label={label} onPress={noop} />
        ))}
      </PreviewRow>
      <PreviewCaption>Disabled</PreviewCaption>
      <PreviewRow>
        {VARIANTS.map(({ variant, label }) => (
          <Button key={variant} variant={variant} label={label} disabled onPress={noop} />
        ))}
      </PreviewRow>
      <PreviewCaption>Loading</PreviewCaption>
      <PreviewRow>
        {VARIANTS.map(({ variant, label }) => (
          <Button key={variant} variant={variant} label={label} loading onPress={noop} />
        ))}
      </PreviewRow>
      <PreviewCaption>Full width, large</PreviewCaption>
      <Button size="large" fullWidth label="Create agent" onPress={noop} />
      <Button variant="text" size="large" fullWidth label="Set up in chat instead" onPress={noop} />
    </PreviewSection>
  );
}

export function ChipsSection() {
  const { theme } = useUnistyles();
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [engine, setEngine] = useState<Provider>("matrix");

  return (
    <PreviewSection title="Chips">
      <PreviewRow>
        {CATEGORIES.map((name) => (
          <Chip key={name} label={name} selected={name === category} onPress={() => setCategory(name)} />
        ))}
      </PreviewRow>
      <PreviewCaption>With a logo; tap one to select it</PreviewCaption>
      <PreviewRow>
        {ENGINES.map(({ provider, label }) => (
          <Chip
            key={provider}
            label={label}
            selected={provider === engine}
            leading={
              <ProviderLogo
                provider={provider}
                color={provider === engine ? theme.v2.colors.onChipSelected : undefined}
              />
            }
            onPress={() => setEngine(provider)}
          />
        ))}
      </PreviewRow>
      <PreviewCaption>Disabled</PreviewCaption>
      <PreviewRow>
        <Chip label="Sales" disabled onPress={noop} />
        <Chip label="All" selected disabled onPress={noop} />
      </PreviewRow>
    </PreviewSection>
  );
}

export function TextFieldSection() {
  const [empty, setEmpty] = useState("");
  const [filled, setFilled] = useState("Portfolio");

  return (
    <PreviewSection title="Text field">
      <TextField clearable value={empty} onChangeText={setEmpty} placeholder="Project name" />
      <TextField clearable value={filled} onChangeText={setFilled} placeholder="Project name" />
      <PreviewCaption>Tap a field to see it focused</PreviewCaption>
    </PreviewSection>
  );
}

export function SearchFieldSection() {
  const [query, setQuery] = useState("matrix");

  return (
    <PreviewSection title="Search field">
      <SearchField placeholder="Search projects" />
      <SearchField placeholder="Search chats" value={query} onChangeText={setQuery} />
    </PreviewSection>
  );
}

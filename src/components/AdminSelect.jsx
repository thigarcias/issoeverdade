import { Children, useId } from "react";
import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

/** Options keep their labels and eligibility; Radix owns focus, typeahead and keyboard navigation. */
export default function AdminSelect({ value, onValueChange, disabled, children, placeholder = "Selecione uma opção" }) {
  const id = useId();
  const options = Children.toArray(children).filter((child) => child?.type === "option");
  const empty = options.find((option) => option.props.value === "");
  return (
    <Select.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <Select.Trigger id={id} className="admin-select-trigger">
        <Select.Value placeholder={empty?.props.children ?? placeholder} />
        <Select.Icon className="admin-select-icon"><ChevronDown size={16} aria-hidden="true" /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="admin-select-content" position="popper" sideOffset={6} collisionPadding={12}>
          <Select.ScrollUpButton className="admin-select-scroll"><ChevronUp size={16} /></Select.ScrollUpButton>
          <Select.Viewport className="admin-select-viewport">
            {options.filter((option) => option.props.value !== "").map((option) => (
              <Select.Item key={option.props.value} value={option.props.value} disabled={option.props.disabled} className="admin-select-item">
                <Select.ItemText>{option.props.children}</Select.ItemText>
                <Select.ItemIndicator className="admin-select-indicator"><Check size={15} aria-hidden="true" /></Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="admin-select-scroll"><ChevronDown size={16} /></Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

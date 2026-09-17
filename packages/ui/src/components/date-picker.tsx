import type { Button as ButtonPrimitive } from "@base-ui/react/button";
import { CalendarDays } from "lucide-react";
import * as React from "react";
import { type DateOnly, formatDateOnly, parseDateOnly } from "../lib/date";
import { cnState } from "../lib/utils";
import { Button } from "./button";
import { Calendar } from "./calendar";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "./popover";

type DatePickerCalendarProps = Omit<
  React.ComponentProps<typeof Calendar>,
  "mode" | "selected" | "defaultSelected" | "onSelect"
>;

type DatePickerButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  "children" | "defaultValue" | "value" | "onChange"
>;

type DatePickerProps = DatePickerButtonProps & {
  /** A local date serialized as YYYY-MM-DD. */
  value?: string;
  /** An initial local date serialized as YYYY-MM-DD. */
  defaultValue?: string;
  /** Called with a local date serialized as YYYY-MM-DD. */
  onValueChange?: (value: DateOnly | undefined) => void;
  /** Alias for onValueChange for form-oriented callers. */
  onChange?: (value: DateOnly | undefined) => void;
  placeholder?: React.ReactNode;
  name?: string;
  required?: boolean;
  calendarProps?: DatePickerCalendarProps;
};

function DatePicker({
  value,
  defaultValue,
  onValueChange,
  onChange,
  placeholder = "Selecione uma data",
  name,
  required = false,
  calendarProps,
  className,
  variant = "outline",
  ...buttonProps
}: DatePickerProps): React.JSX.Element {
  const [uncontrolledValue, setUncontrolledValue] =
    React.useState(defaultValue);
  const currentValue = value === undefined ? uncontrolledValue : value;
  const selectedDate = parseDateOnly(currentValue);
  const submittedValue = selectedDate
    ? (formatDateOnly(selectedDate) ?? "")
    : "";
  const isDisabled = Boolean(buttonProps.disabled);
  const formattedValue = selectedDate
    ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(
        selectedDate,
      )
    : undefined;

  const handleSelect = React.useCallback(
    (date: Date | undefined) => {
      const nextValue = formatDateOnly(date ?? new Date(Number.NaN)) as
        | DateOnly
        | undefined;
      if (value === undefined) setUncontrolledValue(nextValue);
      onValueChange?.(nextValue);
      onChange?.(nextValue);
    },
    [onChange, onValueChange, value],
  );

  return (
    <>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant={variant}
              data-empty={!formattedValue}
              data-date-picker-trigger=""
              className={cnState<ButtonPrimitive.State>(
                "min-w-0 max-w-full w-full justify-start overflow-hidden text-left font-normal data-[empty=true]:text-muted-foreground",
                className,
              )}
              {...buttonProps}
            />
          }
        >
          <CalendarDays aria-hidden="true" className="size-4" />
          {formattedValue ?? placeholder}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <PopoverTitle className="sr-only">Selecionar data</PopoverTitle>
          <Calendar
            {...calendarProps}
            mode="single"
            selected={selectedDate}
            onSelect={handleSelect}
            aria-label={calendarProps?.["aria-label"] ?? "Selecionar data"}
            disabled={isDisabled || calendarProps?.disabled}
          />
        </PopoverContent>
      </Popover>
      {(name || required) && (
        <input
          type="date"
          className="sr-only"
          name={name}
          value={submittedValue}
          required={required}
          disabled={isDisabled}
          tabIndex={-1}
          onChange={() => undefined}
        />
      )}
    </>
  );
}

export { DatePicker, type DatePickerProps };

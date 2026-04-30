import React from 'react';

export function FieldBlock({
    label,
    hint,
    children
}: {
    label: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <label className="field-block">
            <span>{label}</span>
            {children}
            {hint && <small>{hint}</small>}
        </label>
    );
}

export function SelectField({
    label,
    value,
    onChange,
    options,
    hint
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    hint?: string;
}) {
    return (
        <FieldBlock label={label} hint={hint}>
            <select className="field-control" value={value} onChange={(event) => onChange(event.target.value)}>
                {options.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </select>
        </FieldBlock>
    );
}

export function NumberField({
    label,
    value,
    onChange,
    min,
    max,
    step,
    hint
}: {
    label: string;
    value: number;
    onChange: (value: number) => void;
    min: number;
    max: number;
    step: number;
    hint?: string;
}) {
    return (
        <FieldBlock label={label} hint={hint}>
            <input
                className="field-control"
                type="number"
                value={value}
                min={min}
                max={max}
                step={step}
                onChange={(event) => onChange(Number(event.target.value))}
            />
        </FieldBlock>
    );
}

export function InfoPanel({
    title,
    body
}: {
    title: string;
    body: string;
}) {
    return (
        <div className="info-callout">
            <div className="info-callout__title">{title}</div>
            <div className="info-callout__body">{body}</div>
        </div>
    );
}

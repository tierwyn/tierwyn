import { useRef, useMemo } from 'react';

const STRUCTURED_SUMMARY_PRESET = JSON.stringify(
  {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      details: { type: 'string' },
      confidence: { type: 'number' },
    },
    required: ['summary'],
  },
  null,
  2,
);

const ACTION_PLAN_PRESET = JSON.stringify(
  {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            step: { type: 'integer' },
            description: { type: 'string' },
          },
          required: ['step', 'description'],
        },
      },
    },
    required: ['steps'],
  },
  null,
  2,
);

export interface JsonSchemaFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
}

export function JsonSchemaField({
  value,
  onChange,
  placeholder = '{\n  "type": "object",\n  "properties": { ... }\n}',
  maxLength = 8192,
  disabled = false,
}: JsonSchemaFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const validation = useMemo(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      return { status: 'empty' as const, message: '' };
    }
    if (trimmed.startsWith('-')) {
      return { status: 'invalid' as const, message: 'Value cannot start with "-"' };
    }
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { status: 'invalid' as const, message: 'JSON Schema must be a JSON object ({ ... })' };
      }
      const lines = value.split('\n').length;
      return {
        status: 'valid' as const,
        message: `✓ Valid JSON Schema (${lines} lines · ${value.length} chars)`,
      };
    } catch (err) {
      return {
        status: 'invalid' as const,
        message: `⚠ Invalid JSON: ${err instanceof Error ? err.message : 'Syntax error'}`,
      };
    }
  }, [value]);

  const activePreset = useMemo(() => {
    const trimmed = value.trim();
    if (!trimmed) return 'none';
    if (trimmed === STRUCTURED_SUMMARY_PRESET.trim()) return 'summary';
    if (trimmed === ACTION_PLAN_PRESET.trim()) return 'plan';
    return 'custom';
  }, [value]);

  const handlePreset = (preset: 'none' | 'summary' | 'plan' | 'custom') => {
    if (preset === 'none') {
      onChange('');
    } else if (preset === 'summary') {
      onChange(STRUCTURED_SUMMARY_PRESET);
    } else if (preset === 'plan') {
      onChange(ACTION_PLAN_PRESET);
    } else if (preset === 'custom') {
      textareaRef.current?.focus();
    }
  };

  return (
    <div className="json-schema-field">
      <div className="json-schema-presets">
        <span className="json-schema-presets-label">Presets:</span>
        <button
          type="button"
          className={`json-schema-chip${activePreset === 'none' ? ' is-active' : ''}`}
          disabled={disabled}
          onClick={() => handlePreset('none')}
        >
          None
        </button>
        <button
          type="button"
          className={`json-schema-chip${activePreset === 'summary' ? ' is-active' : ''}`}
          disabled={disabled}
          onClick={() => handlePreset('summary')}
        >
          Structured Summary
        </button>
        <button
          type="button"
          className={`json-schema-chip${activePreset === 'plan' ? ' is-active' : ''}`}
          disabled={disabled}
          onClick={() => handlePreset('plan')}
        >
          Action Plan
        </button>
        <button
          type="button"
          className={`json-schema-chip${activePreset === 'custom' ? ' is-active' : ''}`}
          disabled={disabled}
          onClick={() => handlePreset('custom')}
        >
          Custom
        </button>
      </div>

      <textarea
        ref={textareaRef}
        className={`modal-input json-schema-textarea${validation.status === 'invalid' ? ' is-invalid' : ''}`}
        rows={5}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        spellCheck={false}
      />

      <div className="json-schema-status-row">
        {validation.status === 'valid' && (
          <span className="json-schema-status is-valid">{validation.message}</span>
        )}
        {validation.status === 'invalid' && (
          <span className="json-schema-status is-invalid">{validation.message}</span>
        )}
        {validation.status === 'empty' && (
          <span className="json-schema-status is-empty">Inline JSON schema object (max {maxLength} chars)</span>
        )}
      </div>
    </div>
  );
}

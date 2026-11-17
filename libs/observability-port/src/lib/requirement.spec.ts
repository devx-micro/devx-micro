import { normalizeRequirementText, requirementId } from './requirement';

describe('requirement identity (ADR-072 D3, ADR-073 D2)', () => {
  it('normalises layout but keeps line breaks', () => {
    expect(
      normalizeRequirementText(
        '  Must   cite\t\tits source  \r\n  and  quote  it.\r\n\r\n',
      ),
    ).toBe('Must cite its source\nand quote it.');
    expect(normalizeRequirementText('\n\n  x  \n\n')).toBe('x');
  });

  it('applies NFC so composed and decomposed forms are one claim', () => {
    expect(requirementId('café')).toBe(requirementId('café'));
  });

  it('keeps structurally different requirements apart (line breaks are meaning)', () => {
    expect(requirementId('a\nb')).not.toBe(requirementId('a b'));
  });

  it('gives CRLF, CR and LF the same identity', () => {
    expect(requirementId('a\r\nb')).toBe(requirementId('a\nb'));
    expect(requirementId('a\rb')).toBe(requirementId('a\nb'));
  });

  it('is a content id of the normal form, with the 1- prefix', () => {
    expect(requirementId('  hello ')).toBe(
      '1-2cf24dba5fb0a30e26e83b2ac5b9e29e',
    );
  });
});

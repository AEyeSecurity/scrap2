import { describe, expect, it } from 'vitest';
import { applyRdaDateRangeFilter, buildPickerMonthLabel, monthStartFromReportDate } from '../src/rda-report-job';

class FakeLocator {
  constructor(
    private readonly state: {
      activeFieldIndex: number;
      currentLabels: string[];
      selectedDays: Record<number, number | null>;
      acceptClicks: number;
    },
    private readonly selector: string,
    private readonly nthIndex = 0
  ) {}

  locator(selector: string): FakeLocator {
    return new FakeLocator(this.state, selector, this.nthIndex);
  }

  nth(index: number): FakeLocator {
    return new FakeLocator(this.state, this.selector, index);
  }

  first(): FakeLocator {
    return this;
  }

  last(): FakeLocator {
    return this;
  }

  async click(): Promise<void> {
    if (this.selector === 'button.input-date-desktop__custom-date-input') {
      this.state.activeFieldIndex = this.nthIndex;
      return;
    }

    if (this.selector.startsWith('.react-datepicker__day--')) {
      const match = this.selector.match(/day--(\d{3})/);
      this.state.selectedDays[this.state.activeFieldIndex] = match ? Number(match[1]) : null;
      return;
    }

    if (this.selector === 'button:has-text("Aceptar filtro")') {
      this.state.acceptClicks += 1;
    }
  }

  async textContent(): Promise<string> {
    if (this.selector === '.react-datepicker__current-month') {
      return this.state.currentLabels[this.state.activeFieldIndex] ?? '';
    }

    return '';
  }

  async count(): Promise<number> {
    return 1;
  }

  async isVisible(): Promise<boolean> {
    return true;
  }
}

class FakePage {
  public readonly state = {
    activeFieldIndex: 0,
    currentLabels: ['June 2026', 'June 2026'],
    selectedDays: { 0: null, 1: null } as Record<number, number | null>,
    acceptClicks: 0
  };

  locator(selector: string): FakeLocator {
    return new FakeLocator(this.state, selector);
  }

  async waitForTimeout(): Promise<void> {
    // no-op
  }
}

describe('RdA report date range filter', () => {
  it('applies the full June 2026 manual range', async () => {
    const page = new FakePage();

    await applyRdaDateRangeFilter(page as any, '2026-06-30', 1_000);

    expect(monthStartFromReportDate('2026-06-30')).toBe('2026-06-01');
    expect(buildPickerMonthLabel('2026-06-01')).toBe('June 2026');
    expect(page.state.selectedDays).toEqual({ 0: 1, 1: 30 });
    expect(page.state.acceptClicks).toBe(1);
  });
});

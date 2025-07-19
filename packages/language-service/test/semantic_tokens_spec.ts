/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';

import {initMockFileSystem} from '@angular/compiler-cli/src/ngtsc/file_system/testing';
import {LanguageServiceTestEnv, OpenBuffer} from '../testing';
import type {Project} from '../testing';
import {TokenEncodingConsts, TokenType, TokenModifier} from '../src/semantic_tokens';

fdescribe('semantic tokens', () => {
  beforeEach(() => {
    initMockFileSystem('Native');
  });

  it('should return no classifications with format "Original"', () => {
    const {templateFile} = setup('<test-comp/>');
    const actual = templateFile.getEncodedSemanticClassifications(
      undefined,
      ts.SemanticClassificationFormat.Original,
    );

    expect(actual.spans).toHaveSize(0);
    expect(actual.endOfLineState).toBe(ts.EndOfLineState.None);
  });

  it('should classify components in external template', () => {
    const template = `
    <!-- top level -->
    <test-comp></test-comp>
    <test-comp />

    <!-- nested -->
    <div>
      <unknown-comp>
        <test-comp/>
      </unknown-comp>
    </div>
    <test-comp>
      content
    </test-comp>

    <!-- template -->
    <ng-template>
      <test-comp/>
    </ng-template>

    <!-- content -->
    <ng-content>
      <test-comp/>
    </ng-content>

    <!-- defer -->
    @defer {
      <test-comp />
    } @placeholder {
      <test-comp />
    } @loading {
      <test-comp />
    } @error {
      <test-comp />
    }

    <!-- switch -->
    @switch (true) {
      @case (1) {
        <test-comp/>
      } @case (2) {
        <test-comp/>
      } @default {
        <test-comp/>
      }
    }

    <!-- for -->
    @for (item of items;track item) {
      <li> <test-comp/> </li>
    } @empty {
      <li> <test-comp/> </li>
    }

    <!-- if / else -->
    @if (true) {
      <test-comp/>
    } @else if (false) {
      <test-comp/>
    } @else {
      <test-comp/>
    }`;
    const {templateFile} = setup(template);
    const actual = templateFile.getEncodedSemanticClassifications();

    expectClassifications(
      templateFile,
      actual,
      // top level
      semanticToken('class', 'test-comp', 29),
      semanticToken('class', 'test-comp', 41),
      semanticToken('class', 'test-comp', 57),

      // nested
      semanticToken('class', 'test-comp', 131),
      semanticToken('class', 'test-comp', 181),
      semanticToken('class', 'test-comp', 212),

      // template
      semanticToken('class', 'test-comp', 271),

      // ng-content
      semanticToken('class', 'test-comp', 352 - 4),

      // @defer
      semanticToken('class', 'test-comp', 422 - 4),
      semanticToken('class', 'test-comp', 463 - 4),
      semanticToken('class', 'test-comp', 500 - 4),
      semanticToken('class', 'test-comp', 535 - 4),

      // @switch
      semanticToken('class', 'test-comp', 623 - 4),
      semanticToken('class', 'test-comp', 664 - 4),
      semanticToken('class', 'test-comp', 704 - 4),

      // @for
      semanticToken('class', 'test-comp', 798 - 4),
      semanticToken('class', 'test-comp', 843 - 4),

      // @if/else
      semanticToken('class', 'test-comp', 919 - 8),
      semanticToken('class', 'test-comp', 963 - 8),
      semanticToken('class', 'test-comp', 996 - 8),
    );
  });

  it('should classify components in inline template', () => {
    const {templateFile, templateStart} = setupInlineTemplate('<test-comp/>');
    const actual = templateFile.getEncodedSemanticClassifications();
    expectClassifications(
      templateFile,
      actual,
      semanticToken('class', 'test-comp', templateStart + 1),
    );
  });

  it('should perform classification in given range', () => {
    const template = `
    <test-comp>
      <!-- RANGE START -->
      <div>
        <test-comp/>
      </div>
      <!-- RANGE END -->

      <test-comp />
    </test-comp>
  `;
    const {templateFile} = setup(template);
    const actual = templateFile.getEncodedSemanticClassifications({
      start: template.indexOf('RANGE START'),
      length: template.indexOf('RANGE END') - template.indexOf('RANGE START'),
    });

    expectClassifications(templateFile, actual, semanticToken('class', 'test-comp', 65));
  });

  it('should exclude non-component directives', () => {
    const template = `
    <button>Test</button>
    <button test>Test</button>
    `;
    const {templateFile} = setup(template, '', {
      'ButtonDirective': `
        @Directive({
          selector: "button"
        })
        export class ButtonDirective {}
      `,
      'TestDirective': `
        @Directive({
          selector: "[test]"
        })
        export class TestDirective {}
      `,
    });
    const actual = templateFile.getEncodedSemanticClassifications();
    expectClassifications(templateFile, actual);
  });

  it('should classify writable signal properties in typescript', () => {
    const {classContentsStart, templateFile} = setupInlineTemplate(
      '',
      `
        bla = signal(true);
        blah = linkedSignal({
          source: this.bla,
          computation: (value, prev): boolean | undefined => value && prev?.value
        });
        toggle() {
          this.bla.update((value) => !value);
        }
      `,
      {
        '__imports': 'import { linkedSignal, signal } from "@angular/core";',
      },
    );
    const actual = templateFile.getEncodedSemanticClassifications();
    expectClassifications(
      templateFile,
      actual,
      semanticToken('signal', 'bla', classContentsStart + 9),
      semanticToken('signal', 'blah', classContentsStart + 37),
      semanticToken('signal', 'bla', classContentsStart + 82),
      semanticToken('signal', 'bla', classContentsStart + 215),
    );
  });

  it('should classify composite readonly signals in typescript', () => {
    const {classContentsStart, templateFile} = setupInlineTemplate(
      '',
      `
        a = createCompositeSignalInferred();
        b = createCompositeSignalInterface();
        c = createCompositeSignalIntersection();
        toggle() {
          this.a.displayThing((value) => !value);
          this.b.displayThing((value) => !value);
          this.c.displayThing((value) => !value);
        }
      `,
      {
        '__imports': 'import { computed, signal, Signal, WritableSignal } from "@angular/core";',
        '__compositeSignal': `
          function createCompositeSignalInferred() {
            const displayAny = Object.assign(computed((): boolean => Object.values(displayAny).some((s) => s())), {
              displayThing: signal(true),
              displayOtherThing: signal(false),
            });
            return displayAny;
          }
          interface ICompositeSignal extends Signal<boolean> {
            displayThing: WritableSignal<boolean>;
            displayOtherThing: WritableSignal<boolean>;
          }
          function createCompositeSignalInterface(): ICompositeSignal {
            return createCompositeSignalInferred();
          }
          type TCompositeSignal = Signal<boolean> & {
            displayThing: WritableSignal<boolean>;
            displayOtherThing: WritableSignal<boolean>;
          }
          function createCompositeSignalIntersection(): TCompositeSignal {
            return createCompositeSignalInferred();
          }
        `,
      },
    );
    const actual = templateFile.getEncodedSemanticClassifications();
    expectClassifications(
      templateFile,
      actual,
      semanticToken('signal.readonly', 'a', classContentsStart + 9),
      semanticToken('signal.readonly', 'b', classContentsStart + 54),
      semanticToken('signal.readonly', 'c', classContentsStart + 100),
      semanticToken('signal.readonly', 'a', classContentsStart + 175),
      semanticToken('signal', 'displayThing', classContentsStart + 177),
      semanticToken('signal.readonly', 'b', classContentsStart + 225),
      semanticToken('signal', 'displayThing', classContentsStart + 227),
      semanticToken('signal.readonly', 'c', classContentsStart + 275),
      semanticToken('signal', 'displayThing', classContentsStart + 277),
      semanticToken('signal.readonly', 'displayAny', 1013),
      semanticToken('signal.readonly', 'displayAny', 1078),
      semanticToken('signal.readonly', 'displayAny', 1236),
    );
  });

  it('should classify composite writable signals in typescript', () => {
    const {classContentsStart, templateFile} = setupInlineTemplate(
      '',
      `
        a = createCompositeSignalInferred();
        b = createCompositeSignalInterface();
        c = createCompositeSignalIntersection();
        allBla = computed(() => this.a.bla() + this.b.bla() + this.c.bla())
      `,
      {
        '__imports': 'import { computed, signal, Signal, WritableSignal } from "@angular/core";',
        '__compositeSignal': `
          function createCompositeSignalInferred() {
            const state = Object.assign(signal({ foo: 'bar' }), {
              bla: computed((): string => state.foo),
            });
            return state;
          }
          interface ICompositeSignal extends WritableSignal<boolean> {
            bla: Signal<boolean>;
          }
          function createCompositeSignalInterface(): ICompositeSignal {
            return createCompositeSignalInferred();
          }
          type TCompositeSignal = WritableSignal<boolean> & {
            bla: Signal<boolean>;
          }
          function createCompositeSignalIntersection(): TCompositeSignal {
            return createCompositeSignalInferred();
          }
        `,
      },
    );
    const actual = templateFile.getEncodedSemanticClassifications();
    expectClassifications(
      templateFile,
      actual,
      semanticToken('signal', 'a', classContentsStart + 9),
      semanticToken('signal', 'b', classContentsStart + 54),
      semanticToken('signal', 'c', classContentsStart + 100),
      semanticToken('signal.readonly', 'allBla', classContentsStart + 149),
      semanticToken('signal', 'a', classContentsStart + 178),
      semanticToken('signal.readonly', 'bla', classContentsStart + 180),
      semanticToken('signal', 'b', classContentsStart + 193),
      semanticToken('signal.readonly', 'bla', classContentsStart + 195),
      semanticToken('signal', 'c', classContentsStart + 208),
      semanticToken('signal.readonly', 'bla', classContentsStart + 210),
      semanticToken('signal', 'state', 910),
      semanticToken('signal', 'state', 1000),
      semanticToken('signal', 'state', 1047),
    );
  });

  it('should classify input signal properties in typescript', () => {
    const {classContentsStart, templateFile} = setupInlineTemplate('', 'bla = input(true)', {
      '__imports': 'import { input } from "@angular/core";',
    });
    const actual = templateFile.getEncodedSemanticClassifications();
    expectClassifications(
      templateFile,
      actual,
      semanticToken('inputSignal.readonly', 'bla', classContentsStart),
    );
  });

  it('should classify computed signal properties in typescript', () => {
    const {classContentsStart, templateFile} = setupInlineTemplate(
      '',
      `
        bla = signal(true);
        notBla = computed(() => !this.bla());
      `,
      {
        '__imports': 'import { computed, signal } from "@angular/core";',
      },
    );
    const actual = templateFile.getEncodedSemanticClassifications();
    expectClassifications(
      templateFile,
      actual,
      semanticToken('signal', 'bla', classContentsStart + 9),
      semanticToken('signal.readonly', 'notBla', classContentsStart + 37),
      semanticToken('signal', 'bla', classContentsStart + 67),
    );
  });

  it('should classify injected readonly signal properties in typescript', () => {
    const {classContentsStart, templateFile} = setupInlineTemplate(
      '',
      'bla = inject(INJECTED_READONLY_SIGNAL)',
      {
        '__imports': 'import { inject } from "@angular/core";',
        'INJECTED_SIGNAL': `
          import { InjectionToken, signal } from "@angular/core";
          export const INJECTED_SIGNAL = new InjectionToken('', {
            providedIn: 'root',
            factory: () => signal(false),
          });
          export const INJECTED_READONLY_SIGNAL = new InjectionToken('', {
            providedIn: 'root',
            factory: () => inject(INJECTED_SIGNAL).asReadonly(),
          });
        `,
      },
    );
    const actual = templateFile.getEncodedSemanticClassifications();
    expectClassifications(
      templateFile,
      actual,
      semanticToken('signal.readonly', 'bla', classContentsStart),
    );
  });

  it('should classify injected signal properties in typescript', () => {
    const {classContentsStart, templateFile} = setupInlineTemplate(
      '',
      'bla = inject(INJECTED_SIGNAL)',
      {
        '__imports': 'import { inject } from "@angular/core";',
        'INJECTED_SIGNAL': `
          import { InjectionToken, signal } from "@angular/core";
          export const INJECTED_SIGNAL = new InjectionToken('', {
            providedIn: 'root',
            factory: () => signal(false),
          });
        `,
      },
    );
    const actual = templateFile.getEncodedSemanticClassifications();
    expectClassifications(templateFile, actual, semanticToken('signal', 'bla', classContentsStart));
  });

  it('should classify viewChild', () => {
    const {classContentsStart, templateFile, templateStart} = setupInlineTemplate(
      '<test-comp />',
      'bla = viewChild(TestComponent);',
      {
        '__imports': 'import { viewChild } from "@angular/core";',
      },
    );
    const actual = templateFile.getEncodedSemanticClassifications();
    expectClassifications(
      templateFile,
      actual,
      semanticToken('class', 'test-comp', templateStart + 1),
      semanticToken('signal.readonly', 'bla', classContentsStart),
    );
  });
  fit('should classify signal read in inline template', () => {
    const {classContentsStart, templateFile, templateStart} = setupInlineTemplate(
      '{{ bla() }}',
      'bla = signal(1);',
      {
        '__imports': 'import { signal } from "@angular/core";',
      },
    );
    const actual = templateFile.getEncodedSemanticClassifications();
    expectClassifications(
      templateFile,
      actual,
      semanticToken('signal', 'bla', templateStart + 3),
      semanticToken('signal', 'bla', classContentsStart),
    );
  });

  it('should classify signal reads in templates', () => {
    const template = `
    <!-- top level -->
    {{ bla() }}

    <!-- nested -->
    <div>
      {{ bla() }}
    </div>

    <!-- template -->
    <ng-template #templateRef [expectedContext]="context" let-implicit let-a="a" let-b="b" let-deep="deep" let-new="new">>
      {{ bla() }}
    </ng-template>

    <!-- content -->
    <ng-content>
      {{ bla() }}
    </ng-content>

    <!-- defer -->
    @defer {
      {{ bla() }}
    } @placeholder {
      {{ bla() }}
    } @loading {
      <test-comp />
    } @error {
      <test-comp />
    }

    <!-- switch -->
    @switch (true) {
      @case (1) {
        <test-comp/>
      } @case (2) {
        <test-comp/>
      } @default {
        <test-comp/>
      }
    }

    <!-- for -->
    @for (item of items;track item) {
      <li> <test-comp/> </li>
    } @empty {
      <li> <test-comp/> </li>
    }

    <!-- if / else -->
    @if (true) {
      <test-comp/>
    } @else if (false) {
      <test-comp/>
    } @else {
      <test-comp/>
    }`;

    const {classContentsStart, templateFile} = setup(
      template,
      `bla = signal(1);
        context: {
          $implicit: Signal<unknown>;
          a: Signal<unknown>;
          b: Signal<unknown>;
          deep: {next: {text: Signal<unknown>}};
          new?: Signal<unknown>;
        } = {
          $implicit: signal('Default Implicit'),
          a: signal('Default A'),
          b: signal('Default B'),
          deep: {next: {text: signal('Default deep text'}}),
        }
        `,
      {
        '__imports': 'import { signal, Signal } from "@angular/core";',
        'TestPipe': `
          @Pipe({name: 'test', standalone: false})
          export class TestPipe {
            transform(value: unknown) {
              return value;
            }
          }`,
        'ExpectedContextDirective': `
          @Directive({
            selector: 'ng-template[expectedContext]',
            standalone: false,
          })
          export class ExpectedContextDirective<T> {
            @Input()
            expectedContext!: T;

            static ngTemplateContextGuard<T>(
              _dir: ExpectedContextDirective<T>,
              _ctx: unknown,
            ): _ctx is T {
              return true;
            }
          }`,
      },
    );
    const actual = templateFile.getEncodedSemanticClassifications();
    expectClassifications(
      templateFile,
      actual,
      semanticToken('signal', 'bla', 31),
      semanticToken('signal', 'bla', classContentsStart),
    );
  });
});

function setup(
  template: string,
  classContents: string = '',
  otherDeclarations: {[name: string]: string} = {},
): {
  project: Project;
  classContentsStart: number;
  componentFile: OpenBuffer;
  templateFile: OpenBuffer;
} {
  const decls = [
    'AppCmp',
    ...Object.keys(otherDeclarations).filter((name) => !name.startsWith('__')),
  ];

  const otherDirectiveClassDecls = Object.values(otherDeclarations).join('\n\n');

  const env = LanguageServiceTestEnv.setup();
  const project = env.addProject('test', {
    'test.ts': `
         import { Component, Directive, Input, Output, NgModule } from '@angular/core';

         @Component({
           templateUrl: './test.html',
           selector: 'app-cmp',
         })
         export class AppCmp {
           ${classContents}
         }

        @Component({
          selector: 'test-comp',
          template: '<div>Testing: {{name}}</div>',
        })
        export class TestComponent {
          @Input() name!: string;
          @Output() testEvent!: EventEmitter<string>;
        }
         ${otherDirectiveClassDecls}

         @NgModule({
           declarations: [${decls.join(', ')}],
         })
         export class AppModule {}
         `,
    'test.html': template,
  });
  return {
    project,
    classContentsStart: 237,
    componentFile: project.openFile('test.ts'),
    templateFile: project.openFile('test.html'),
  };
}

function setupInlineTemplate(
  template: string,
  classContents: string = '',
  otherDeclarations: {[name: string]: string} = {},
): {
  classContentsStart: number;
  templateFile: OpenBuffer;
  templateStart: number;
} {
  const decls = [
    'AppCmp',
    ...Object.keys(otherDeclarations).filter((name) => !name.startsWith('__')),
  ];

  const otherDirectiveClassDecls = Object.values(otherDeclarations).join('\n\n');

  const env = LanguageServiceTestEnv.setup();
  const project = env.addProject('test', {
    'test.ts': `
         import { Component, Input, Output, NgModule } from '@angular/core';

         @Component({
           template: '${template}',
           selector: 'app-cmp',
         })
         export class AppCmp {
           ${classContents}
         }

        import { EventEmitter } from '@angular/core';
        @Component({
          selector: 'test-comp',
          template: '<div>Testing: {{name}}</div>',
        })
        export class TestComponent {
          @Input() name!: string;
          @Output() testEvent!: EventEmitter<string>;
        }
         ${otherDirectiveClassDecls}

         @NgModule({
           declarations: [${decls.join(', ')}],
         })
         export class AppModule {}
         `,
  });
  const templateFile = project.openFile('test.ts');
  const templateStart = 123;
  const classContentsStart = templateStart + template.length + 89;
  return {classContentsStart, templateFile, templateStart};
}

function expectClassifications(
  buffer: OpenBuffer,
  actual: ts.Classifications,
  ...expected: TestClassification[]
) {
  expect(actual.spans.length / 3)
    .withContext('Number of classifications')
    .toBe(expected.length);
  expect(actual.endOfLineState).toBe(ts.EndOfLineState.None);

  let actualPositions = new Set(actual.spans.filter((x, i) => i % 3 === 0));
  for (const expectedToken of expected) {
    const {start, length, type} = findTokenAtPosition(
      actual.spans,
      expectedToken.position,
      `"${expectedToken.text}" with type ${expectedToken.type}`,
    );
    actualPositions.delete(start);
    const text = buffer.contents.substring(start, start + length);

    if (typeof start === 'number') {
      expect(start).withContext('start').toBe(expectedToken.position);
      expect(text).toBe(expectedToken.text);
      expect(type).withContext(`of "${text}" at ${start}`).toBe(expectedToken.type);
    }
  }
  expect(
    [...actualPositions].map((pos) => {
      const found = findTokenAtPosition(actual.spans, pos);
      const {start, length} = found;
      const context = 6;
      return {
        ...found,
        after: buffer.contents.substring(start - context, start),
        before: buffer.contents.substring(start + length, start + length + context),
        contents: buffer.contents.substring(start, start + length),
      };
    }),
  ).toHaveSize(0);
}

interface TestClassification {
  type: string;
  text: string;
  position: number;
}

/**
 * Creates a semantic token
 * @param type type and modifiers in dot notation, e.g. `class.defaultLibrary`.
 * @param text the expected text to be highlighted
 * @param position the expected offset to the start of the token
 *
 */
function semanticToken(type: string, text: string, position: number): TestClassification {
  return {
    type,
    text,
    position,
  };
}

/**
 * Converts the token type bit set to a human readable string
 * @param classification the encoded bit set
 */
function convertToString(classification: number) {
  const typeIdx =
    classification > TokenEncodingConsts.typeOffset
      ? (classification >> TokenEncodingConsts.typeOffset) - 1
      : 0;
  const modifiers = classification & TokenEncodingConsts.modifierMask;

  const typeName = TOKEN_TYPES[typeIdx];
  const modifierNames = Object.entries(TOKEN_MODIFIERS)
    .filter(([i]) => modifiers & (1 << parseInt(i)))
    .map(([_, name]) => name);

  return [typeName, ...modifierNames].join('.');
}

function findTokenAtPosition(spans: number[], pos: number, extraContext = '') {
  const idx = spans.findIndex((n, i) => i % 3 === 0 && pos === n);
  expect(idx)
    .withContext(`Expected token for position ${pos} ${extraContext}`)
    .toBeGreaterThanOrEqual(0);

  return {
    start: spans[idx],
    length: spans[idx + 1],
    type: convertToString(spans[idx + 2]),
  };
}

/**
 * Mappings to string representation of token types
 */
const TOKEN_TYPES: {[type: number]: string} = {
  [TokenType.class]: 'class',
  [TokenType.enum]: 'enum',
  [TokenType.interface]: 'interface',
  [TokenType.namespace]: 'namespace',
  [TokenType.typeParameter]: 'typeParameter',
  [TokenType.type]: 'type',
  [TokenType.parameter]: 'parameter',
  [TokenType.variable]: 'variable',
  [TokenType.enumMember]: 'enumMember',
  [TokenType.property]: 'property',
  [TokenType.function]: 'function',
  [TokenType.member]: 'member',
  [TokenType.signal]: 'signal',
  [TokenType.inputSignal]: 'inputSignal',
};

/**
 * Mappings to string representation of token modifiers
 */
const TOKEN_MODIFIERS: {[type: number]: string} = {
  [TokenModifier.declaration]: 'declaration',
  [TokenModifier.static]: 'static',
  [TokenModifier.async]: 'async',
  [TokenModifier.readonly]: 'readonly',
  [TokenModifier.defaultLibrary]: 'defaultLibrary',
  [TokenModifier.local]: 'local',
};

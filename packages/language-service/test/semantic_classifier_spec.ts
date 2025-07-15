/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {initMockFileSystem} from '@angular/compiler-cli/src/ngtsc/file_system/testing';

import {createModuleAndProjectWithDeclarations, LanguageServiceTestEnv} from '../testing';
import {SemanticClassificationFormat} from 'typescript';
import {getSemanticClassificationsImpl, type AddSignalSpan} from '../src/semantic_classifier';
fdescribe('semantic classifier', () => {
  let env: LanguageServiceTestEnv;
  let collectedSignals: Array<{
    start: number;
    length: number;
    isReadonly: boolean;
    isInput: boolean;
  }>;
  const addSignalSpan: AddSignalSpan = (start, length, isReadonly, isInput) =>
    collectedSignals!.push({start, length, isReadonly, isInput});

  beforeEach(() => {
    initMockFileSystem('Native');
    env = LanguageServiceTestEnv.setup();
    collectedSignals = [];
  });

  it('should not classify a non-Angular property', () => {
    const files = {
      'app.ts': `
        import {Directive, Input} from '@angular/core';

        @Directive({})
        export class AppComponent {
          bla = true;
        }
     `,
    };

    const project = createModuleAndProjectWithDeclarations(env, 'test', files);
    const appFile = project.openFile('app.ts');
    appFile.moveCursorToText('bl¦a');

    project.getSemanticTokens('app.ts', appFile.span, addSignalSpan);
    expect(collectedSignals.length).toBe(0);
  });

  describe('input fields', () => {
    it('should not classify an `@Input` property', () => {
      const files = {
        'app.ts': `
        import {Directive, Input} from '@angular/core';

        @Directive({})
        export class AppComponent {
          @Input() bla = true;
        }
     `,
      };

      const project = createModuleAndProjectWithDeclarations(env, 'test', files);
      const appFile = project.openFile('app.ts');
      appFile.moveCursorToText('bl¦a');
      project.getSemanticTokens('app.ts', appFile.span, addSignalSpan);
      expect(collectedSignals.length).toBe(0);
    });

    it('should classify a signal input property', () => {
      const files = {
        'app.ts': `
        import {Directive, input} from '@angular/core';

        @Directive({})
        export class AppComponent {
          bla = input(true);
        }
     `,
      };

      const project = createModuleAndProjectWithDeclarations(env, 'test', files);
      const appFile = project.openFile('app.ts');
      appFile.moveCursorToText('bl¦a');
      const target = appFile.getReferencesAtPosition();
      expect(target?.length).toBeTruthy();
      const classifications = project.getSemanticTokens(
        'app.ts',
        target![0].textSpan,
        SemanticClassificationFormat.TwentyTwenty,
      );
      expect(classifications.spans.length).toBe(3);
    });

    fit('should classify signal input in inline template', () => {
      const files = {
        'app.ts': `
      import {Component, NgModule} from '@angular/core';

      @Component({
        template: 'Hello world! {{bla()}}',
        standalone: false,
      })
      export class AppComponent {
        bla = input(true);
      }
    `,
      };

      const project = createModuleAndProjectWithDeclarations(env, 'test', files);
      const appFile = project.openFile('app.ts');
      project.getSemanticTokens('app.ts', appFile.span, addSignalSpan);
      expect(collectedSignals.length).toBe(2);
    });

    fit('should classify signal input in external template', () => {
      const files = {
        'app.ts': `
      import {Component, NgModule} from '@angular/core';

      @Component({
        templateUrl: './app.html',
        standalone: false,
      })
      export class AppComponent {
        bla = input(true);
      }
    `,
        'app.html': `Hello world! {{bla()}}`,
      };

      const project = createModuleAndProjectWithDeclarations(env, 'test', files);
      const appFile = project.openFile('app.html');
      project.getSemanticTokens('app.html', appFile.span, addSignalSpan);
      expect(collectedSignals.length).toBe(1);
    });
  });

  describe('viewChild fields', () => {
    it('should not classify an `@ViewChild` property', () => {
      const files = {
        'app.ts': `
        import {ViewChild, Component} from '@angular/core';

        @Component({template: ''})
        export class AppComponent {
          @ViewChild('ref') ref!: ElementRef;
        }
     `,
      };

      const project = createModuleAndProjectWithDeclarations(env, 'test', files);
      const appFile = project.openFile('app.ts');
      appFile.moveCursorToText('re¦f!: ElementRef');
      const refactorings = project.getRefactoringsAtPosition('app.ts', appFile.cursor);

      expect(refactorings.length).toBe(4);
      expect(refactorings[0].name).toBe('convert-field-to-signal-query-safe-mode');
      expect(refactorings[1].name).toBe('convert-field-to-signal-query-best-effort-mode');
      expect(refactorings[2].name).toBe('convert-full-class-to-signal-queries-safe-mode');
      expect(refactorings[3].name).toBe('convert-full-class-to-signal-queries-best-effort-mode');
    });

    it('should classify a signal query property', () => {
      const files = {
        'app.ts': `
        import {Directive, viewChild} from '@angular/core';

        @Directive({})
        export class AppComponent {
          bla = viewChild('ref');
        }
     `,
      };

      const project = createModuleAndProjectWithDeclarations(env, 'test', files);
      const appFile = project.openFile('app.ts');
      appFile.moveCursorToText('bl¦a');
      const refactorings = project.getRefactoringsAtPosition('app.ts', appFile.cursor);

      expect(refactorings.length).toBe(0);
    });
  });
});

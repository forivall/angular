import {NgCompiler} from '@angular/compiler-cli/src/ngtsc/core';
import ts from 'typescript';

export function getSemanticClassificationsImpl(
  fileName: string,
  compiler: NgCompiler,
  span: ts.TextSpan,
  addSignalSpan: (start: number, length: number, isReadonly: boolean, isInput: boolean) => void,
) {
  const program = compiler.getCurrentProgram();
  const sourceFile = program?.getSourceFile(fileName);
  if (!program || !sourceFile) {
    return;
  }

  function addSignalSpanForNode(node: ts.Node, isReadonly: boolean, isInput: boolean) {
    addSignalSpan(node.getStart(sourceFile), node.getWidth(sourceFile), isReadonly, isInput);
  }

  const typeChecker = program.getTypeChecker();

  let inJSXElement = false;

  function visit(node: ts.Node) {
    if (
      !node ||
      !ts.textSpanIntersectsWith(span, node.pos, node.getFullWidth()) ||
      node.getFullWidth() === 0
    ) {
      return;
    }
    const prevInJSXElement = inJSXElement;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      inJSXElement = true;
    }
    if (ts.isJsxExpression(node)) {
      inJSXElement = false;
    }

    collectSignalSpan: if (
      ts.isIdentifier(node) &&
      !inJSXElement &&
      !inImportClause(node) &&
      !isInfinityOrNaNString(node.escapedText)
    ) {
      let symbol = typeChecker.getSymbolAtLocation(node);
      if (symbol) {
        if (symbol.flags & ts.SymbolFlags.Alias) {
          symbol = typeChecker.getAliasedSymbol(symbol);
        }
        const symbolType = typeChecker.getTypeOfSymbol(symbol);
        const typeSymbol = symbolType.symbol;
        const typeName = typeSymbol.name;
        if (process.env['DEBUG'] !== '0') debugger;
        let isSignalTypeName = false;
        let isInput = false;
        let isReadonly = false;
        switch (typeName) {
          //@ts-expect-error fallthrough
          case 'InputSignal':
            isInput = true;
          //@ts-expect-error fallthrough
          case 'Signal':
            isReadonly = true;
          case 'WritableSignal':
            isSignalTypeName = true;
        }
        if (isSignalTypeName) {
          const isAngularCoreSignal = typeSymbol.declarations?.some((decl) =>
            /\/@angular\/core\//.test(decl.getSourceFile().fileName),
          );
          if (isAngularCoreSignal) {
            addSignalSpanForNode(node, isReadonly, isInput);
            break collectSignalSpan;
          }
        }

        if (symbol.flags & ts.SymbolFlags.Property) {
          const decl = symbol.valueDeclaration;
          if (decl) {
            const declType = (decl as ts.HasType).type;
            if (declType) {
              const declText = declType.getText();
              if (/\bWritableSignal\b/.test(declText)) {
                addSignalSpanForNode(node, false, false);
              } else if (/\bSignal\b/.test(declText)) {
                addSignalSpanForNode(node, true, false);
              }
              break collectSignalSpan;
            }
            if (
              ts.hasOnlyExpressionInitializer(decl) &&
              decl.initializer &&
              ts.isCallExpression(decl.initializer)
            ) {
              const declExpression = decl.initializer.expression;
              if (ts.isIdentifier(declExpression)) {
                const initializerExpressionText = declExpression.getText();
                switch (initializerExpressionText) {
                  case 'signal':
                  case 'computed':
                  case 'input':
                  case 'linkedSignal':
                  case 'viewChild':
                    throw new Error('TODO: found unexpected non-angular signal init');
                }
              } else if (
                ts.isPropertyAccessExpression(declExpression) &&
                declExpression.name.getText() === 'asReadonly'
              ) {
                throw new Error('TODO: found non-angular asReadonly signal');
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);

    inJSXElement = prevInJSXElement;
  }
  visit(sourceFile);
}

function inImportClause(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    parent &&
    (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent))
  );
}
function isInfinityOrNaNString(name: string | ts.__String): boolean {
  return name === 'Infinity' || name === '-Infinity' || name === 'NaN';
}

function isRightSideOfQualifiedNameOrPropertyAccess(node: ts.Node): boolean {
  return (
    (ts.isQualifiedName(node.parent) && node.parent.right === node) ||
    (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
  );
}

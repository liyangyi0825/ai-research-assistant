import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { BillingFeatureUnavailable } from "../../components/billing/BillingFeatureUnavailable";

test("the closed billing view gives a neutral availability notice without tying it to filing status", () => {
  const markup = renderToStaticMarkup(createElement(BillingFeatureUnavailable));

  assert.match(markup, /收费功能暂未开放/);
  assert.match(markup, /开放时间以站内通知为准/);
  assert.match(markup, /现有科研功能不受影响/);
  assert.doesNotMatch(markup, /备案/);
});

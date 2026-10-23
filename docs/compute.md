# Compute rules: carts and checkout

What a cart or checkout page shows depends on everything the agent did before: which items, how
many, which codes. The combinations cannot all be recorded. Instead, a task records a few real
cart pages, and `tasks/<id>/compute.yaml` says:

- which requests change the cart (**ops**),
- which pages show it, and where on them the numbers go (**views**),
- how the numbers are computed (**items**, **tax**, **shipping**, **promotions**),
- which recorded pages the rules must reproduce exactly (**samples**).

During a run, the replay engine keeps a cart for the agent, updates it on every op, and renders
views by taking a recorded page and writing the computed values into it.

## Worked example: the Amazon cart

The recording of `amazon-airpods` contains: the add-to-cart request (1 item), a cart page with 1
item ($199.00), the change-quantity request, a cart page with 2 items ($398.00), and an empty
cart page. The full file is [tasks/amazon-airpods/compute.yaml](../tasks/amazon-airpods/compute.yaml).

### 1. Find the requests and pages

The recording tool lists every non-GET request of a recording for review. For Amazon, the ones
that change the cart were `POST /cart/add-to-cart/…` (form fields `ASIN`, `quantity`) and
`POST /cart/ref=ox_sc_update_quantity…` (fields `asin`, `quantity.<line id>`). The cart page is
`GET /gp/cart/view.html`. Give each an endpoint in the site rules (`sites/amazon.com.yaml`) with
the right kind:

```yaml
endpoints:
  - { name: add_to_cart, match: "POST /cart/add-to-cart/**", kind: stateful, body_keep: [ASIN, quantity] }
  - { name: cart_update_quantity, match: "POST /cart/ref=ox_sc_update_quantity*", kind: stateful, body_keep: [asin, actionType] }
  - { name: cart_view, match: "GET /gp/cart/view.html", kind: computed }
```

### 2. Prices and pricing rules

Take prices from the recorded product or cart pages. Write only what the site shows: Amazon's
cart shows a subtotal, and tax and shipping appear only at checkout, which needs sign-in, so this
task has no `tax` or `shipping`.

```yaml
symbol: "$"
items:
  B0FQFB8FMG: { title: "Apple AirPods Pro 3 Wireless Earbuds with Active Noise Cancellation", price: 199.00 }
```

### 3. Ops: map requests to cart changes

```yaml
ops:
  - endpoint: add_to_cart              # endpoint name from the site rules
    op: add                            # add | set_qty | remove | apply_code | clear
    item: { from: body, field: ASIN }  # from: query | body | capture | const
    qty: { from: body, field: quantity, default: 1 }
    respond: recorded                  # answer with the recorded response (the redirect after adding)
  - endpoint: cart_update_quantity
    op: set_qty
    item: { from: body, field: asin }
    qty: { from: body, field: "quantity.*" }   # the field name contains the line id; * matches it
    respond: recorded
```

### 4. Views: where the numbers go

Open the recorded cart page and find the elements that show the numbers. `template` picks which
recorded response to fill in (`contains` filters on body text); `empty_template` is returned
unchanged when the cart is empty.

```yaml
views:
  - name: cart
    endpoint: cart_view
    type: html
    template: { url_contains: "/gp/cart/view.html", contains: 'data-itemtype="active"', pick: first }
    empty_template: { url_contains: "/gp/cart/view.html", contains: "Your Amazon Cart is empty", pick: first }
    set:
      - { selector: "#sc-subtotal-amount-buybox .sc-price", value: "{{money subtotal}}" }
      - { selector: "#sc-subtotal-label-buybox", value: "Subtotal ({{count}} {{plural count 'item' 'items'}}):" }
      - { selector: '[data-maple-math="cost-after-savings"]', value: "{{money_sub subtotal 50}}" }   # card banner: subtotal minus a $50 gift card
    lines:                             # one row per cart line, cloned from the first recorded row
      row: 'div[data-asin][data-itemtype="active"]'
      set:
        - { selector: ":self", attr: data-quantity, value: "{{line.qty}}" }
        - { selector: '[data-a-selector="inner-value"]', value: "{{line.qty}}" }
decorate:                              # every page of the site: the cart badge in the header
  - site: amazon
    set:
      - { selector: "#nav-cart-count", value: "{{count}}" }
```

### 5. Samples: prove the rules reproduce the recording

Each sample sets a cart state, picks the recorded page for that state, and compares the values the
rules compute with the values on the page.

```yaml
samples:
  - name: recorded cart with 2 items
    state: { lines: [{ item: B0FQFB8FMG, qty: 2 }], codes: [] }
    page: { url_contains: "/gp/cart/view.html", contains: 'data-quantity="2"' }
    extract: { subtotal: "#sc-subtotal-amount-buybox .sc-price", count: "#nav-cart-count" }
```

```bash
node bin/pab.js compute-check amazon-airpods
PASS  recorded cart with 1 item
      ok  subtotal: expected 199 (page), computed 199
PASS  recorded cart with 2 items
      ok  subtotal: expected 398 (page), computed 398
```

### 6. Try a state that was never recorded

```bash
node bin/pab.js replay amazon-airpods
```

Add 3 to the cart: the cart shows "Subtotal (3 items): $597.00", quantity 3, badge 3, though only
1 and 2 were recorded. `http://rr.control/state` through the proxy shows the cart and totals.

## Recording for compute rules

Record the states the rules have to reproduce: 1 and 2 of an item, with and without a code, below
and above a free-shipping threshold, and the empty cart. Each one becomes a sample.

## Reference

```yaml
symbol: "$"
items: { <item id>: { title: "...", price: 19.99 } }
tax: { rate: 0.08875, rounding: total, include_shipping: false }   # rounding: total | line
shipping: { fee: 5.99, free_threshold: 35 }
promotions:
  - { code: SAVE10, type: percent, value: 10, min_subtotal: 50, group: coupon }   # one per group: the largest
initial_state: { lines: [], codes: [] }
ops: [...]
views: [...]
decorate: [...]
samples: [...]
```

Template values: `subtotal`, `discount`, `shipping`, `tax`, `total`, `count`, `codes`, `lines`;
per line `line.item`, `line.title`, `line.qty`, `line.unit`, `line.amount`. Helpers: `money x`,
`money_sub x y` (difference, at least 0), `fixed x`, `number x`, `plural x 'item' 'items'`.

JSON views use `json_set: [{ path, value, as: number }]` and `json_lines: { path, item: { field: template } }`.

Arithmetic is done in cents. An item missing from `items` is left out of the totals and listed in
`unknownItems` in `/state`; prices are never invented. A state op whose body differs from the
recording (another quantity) still answers with that endpoint's recorded response; the cart
itself is the compute module's job.

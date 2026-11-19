# page-versions

A Stacki app that lets a client approve a site page by page. Choices, confirmations and approvals are kept in the project, so they commit and pull with the site.

## What it does

- **Page tree with progress**: every page is one row with its status; the top shows how many pages are approved. All approved means ready for build.
- **Page versions**: compare whole-page versions and let the client pick one.
- **Section variants**: offer several designs of one section on a page and let the client switch between them and pick one.
- **Confirmation**: an admin confirms each choice; a confirmed choice is locked.
- **Approval**: once every choice on a page is confirmed, the page can be approved. Admins can leave pages out of the count.
- **Feedback access**: an admin can close or reopen feedback for everyone or per person.

## Section variants

Wrap the designs of a section in the page:

```astro
<div data-variant-group="Hero" data-variant-active="a">
  <div data-variant="a" data-variant-label="Current">…</div>
  <div data-variant="b" data-variant-label="With video">…</div>
</div>
```

The site needs this CSS once, so only the active variant shows. Variant ids are `a` to `d`.

```css
[data-variant-group],
[data-variant] {
  display: contents;
}

[data-variant-group] > [data-variant] {
  display: none;
}

[data-variant-group]:not([data-variant-active]) > [data-variant]:first-child,
[data-variant-active="a"] > [data-variant="a"],
[data-variant-active="b"] > [data-variant="b"],
[data-variant-active="c"] > [data-variant="c"],
[data-variant-active="d"] > [data-variant="d"] {
  display: contents;
}
```

Switching a variant writes `data-variant-active` in the page file, so the person switching needs a role that may edit the page. Remove the variants that were not chosen before the build.

// Roles & Access page (Admin role only). Uses helpers from admin.js: jsonRequest, showAlert,
// escapeHtml.
(function () {
  let catalog = { actions: [], resources: [] };
  let roles = [];
  let staff = [];
  let editingRole = null;

  const $id = (id) => document.getElementById(id);
  const esc = (v) => escapeHtml(String(v));

  function getJson(url) {
    return fetch(url, { credentials: 'include' }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw { status: res.status, responseJSON: data };
      return data;
    });
  }
  function fail(prefix, err) {
    showAlert(prefix + ((err && err.responseJSON && err.responseJSON.message) || 'Something went wrong.'), 'danger');
  }
  function options(items, placeholder) {
    const first = placeholder ? `<option value="">${esc(placeholder)}</option>` : '';
    return first + items.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join('');
  }
  function keepSelection(select, html) {
    const previous = select.value;
    select.innerHTML = html;
    if (previous && Array.from(select.options).some((o) => o.value === previous)) select.value = previous;
  }

  window.loadRolesPage = async function () {
    try {
      const [cat, roleList, staffList] = await Promise.all([
        getJson('/admin/permissions/catalog'),
        getJson('/admin/roles'),
        getJson('/admin/staff')
      ]);
      catalog = cat; roles = roleList; staff = staffList;
      render();
    } catch (err) {
      fail('Could not load roles: ', err);
    }
  };

  function render() {
    renderRoleList();
    renderStaffList();
    const roleNames = roles.map((r) => r.name);
    const userNames = staff.map((s) => s.username);
    keepSelection($id('addRoleUser'), options(userNames, 'Select User...'));
    keepSelection($id('addRoleName'), options(roleNames, 'Select Role...'));
    keepSelection($id('listRolesUser'), options(userNames, 'Select User...'));
    keepSelection($id('removeRoleUser'), options(userNames, 'Select User...'));
    keepSelection($id('newStaffRole'), options(roleNames));
    if ($id('newStaffRole').querySelector('option[value="Staff"]') && !$id('newStaffRole').dataset.touched) {
      $id('newStaffRole').value = 'Staff';
    }
    renderRemoveRoleOptions();
  }

  function renderRoleList() {
    const body = $id('roleListBody');
    if (!roles.length) { body.innerHTML = '<tr><td colspan="2" class="text-muted">No roles yet.</td></tr>'; return; }
    body.innerHTML = roles.map((r) => {
      const badge = r.isSuper ? ' <span class="badge bg-dark">Full access</span>' : (r.isSystem ? ' <span class="badge bg-secondary">Built-in</span>' : '');
      const del = r.isSystem
        ? '<button class="btn btn-outline-secondary btn-sm" disabled title="Built-in roles cannot be deleted">Delete</button>'
        : `<button class="btn btn-outline-danger btn-sm role-delete" data-name="${esc(r.name)}">Delete</button>`;
      const perm = r.isSuper
        ? '<button class="btn btn-outline-secondary btn-sm" disabled title="Admin always has every permission">Permission</button>'
        : `<button class="btn btn-outline-secondary btn-sm role-permission" data-name="${esc(r.name)}">Permission</button>`;
      return `<tr><td><strong>${esc(r.name)}</strong>${badge}</td><td class="text-end"><div class="d-inline-flex gap-1">${del}${perm}</div></td></tr>`;
    }).join('');
  }

  function renderStaffList() {
    const body = $id('staffListBody');
    if (!staff.length) { body.innerHTML = '<tr><td colspan="3" class="text-muted">No staff accounts yet. Add one below.</td></tr>'; return; }
    body.innerHTML = staff.map((s) => {
      const badges = s.roles.length
        ? s.roles.map((r) => `<span class="badge bg-info text-dark me-1">${esc(r)}</span>`).join('')
        : '<span class="text-muted">No role</span>';
      return `<tr><td><strong>${esc(s.username)}</strong></td><td>${badges}</td>` +
        `<td class="text-end"><button class="btn btn-outline-danger btn-sm staff-delete" data-username="${esc(s.username)}">Remove</button></td></tr>`;
    }).join('');
  }

  function renderRemoveRoleOptions() {
    const user = staff.find((s) => s.username === $id('removeRoleUser').value);
    $id('removeRoleName').innerHTML = options(user ? user.roles : [], 'Select Role...');
  }

  function openPermissions(name) {
    const role = roles.find((r) => r.name === name);
    if (!role) return;
    editingRole = role.name;
    $id('permissionRoleName').textContent = role.name;
    const granted = new Set(role.permissions);
    $id('permissionMatrixBody').innerHTML = catalog.resources.map((res, i) => {
      const cells = catalog.actions.map((act) => {
        if (!res.actions[act]) return '<td class="text-muted">&mdash;</td>';
        const perm = `${res.key}.${act}`;
        return `<td><input type="checkbox" class="form-check-input perm-check" data-perm="${esc(perm)}" ${granted.has(perm) ? 'checked' : ''} aria-label="${esc(res.name + ' ' + act)}"></td>`;
      }).join('');
      return `<tr><td>${i + 1}</td><td><strong>${esc(res.name)}</strong> <span class="text-muted">(${esc(res.description)})</span></td>${cells}</tr>`;
    }).join('');
    bootstrap.Modal.getOrCreateInstance($id('permissionModal')).show();
  }

  document.addEventListener('DOMContentLoaded', function () {
    $id('createRoleForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const name = $id('newRoleName').value.trim();
      jsonRequest('/admin/roles', 'POST', { name })
        .then(() => { $id('newRoleName').value = ''; showAlert(`Role "${name}" created. Click Permission to choose what it can do.`, 'success'); loadRolesPage(); })
        .catch((err) => fail('Could not create role: ', err));
    });

    $id('roleListBody').addEventListener('click', function (e) {
      const del = e.target.closest('.role-delete');
      const perm = e.target.closest('.role-permission');
      if (perm) return openPermissions(perm.dataset.name);
      if (del) {
        const name = del.dataset.name;
        if (!confirm(`Delete the role "${name}"? It will be removed from everyone who has it.`)) return;
        jsonRequest(`/admin/roles/${encodeURIComponent(name)}`, 'DELETE')
          .then(() => { showAlert(`Role "${name}" deleted.`, 'success'); loadRolesPage(); })
          .catch((err) => fail('Could not delete role: ', err));
      }
    });

    $id('savePermissionsBtn').addEventListener('click', function () {
      const permissions = Array.from(document.querySelectorAll('#permissionMatrixBody .perm-check:checked')).map((c) => c.dataset.perm);
      const name = editingRole;
      jsonRequest(`/admin/roles/${encodeURIComponent(name)}/permissions`, 'PUT', { permissions })
        .then(() => {
          bootstrap.Modal.getOrCreateInstance($id('permissionModal')).hide();
          showAlert(`Permissions saved for "${name}".`, 'success');
          loadRolesPage();
        })
        .catch((err) => fail('Could not save permissions: ', err));
    });

    $id('createStaffForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const username = $id('newStaffUsername').value.trim();
      const password = $id('newStaffPassword').value;
      const role = $id('newStaffRole').value;
      jsonRequest('/admin/staff', 'POST', { username, password, roles: role ? [role] : [] })
        .then(() => {
          $id('createStaffForm').reset();
          showAlert(`Account "${username.toLowerCase()}" created.`, 'success');
          loadRolesPage();
        })
        .catch((err) => fail('Could not create account: ', err));
    });
    $id('newStaffRole').addEventListener('change', function () { this.dataset.touched = '1'; });

    $id('staffListBody').addEventListener('click', function (e) {
      const btn = e.target.closest('.staff-delete');
      if (!btn) return;
      const username = btn.dataset.username;
      if (!confirm(`Remove the account "${username}"? They will lose access immediately.`)) return;
      jsonRequest(`/admin/staff/${encodeURIComponent(username)}`, 'DELETE')
        .then(() => { showAlert(`Account "${username}" removed.`, 'success'); loadRolesPage(); })
        .catch((err) => fail('Could not remove account: ', err));
    });

    $id('addRoleForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const username = $id('addRoleUser').value;
      const role = $id('addRoleName').value;
      if (!username || !role) { showAlert('Select a user and a role first.', 'warning'); return; }
      jsonRequest(`/admin/staff/${encodeURIComponent(username)}/roles`, 'POST', { role })
        .then(() => { showAlert(`"${role}" added to ${username}.`, 'success'); loadRolesPage(); })
        .catch((err) => fail('Could not add role: ', err));
    });

    $id('getRolesBtn').addEventListener('click', function () {
      const username = $id('listRolesUser').value;
      const out = $id('userRolesResult');
      if (!username) { out.innerHTML = '<div class="text-muted">Select a user first.</div>'; return; }
      getJson(`/admin/staff/${encodeURIComponent(username)}/roles`)
        .then((d) => {
          const roleBadges = d.roles.length
            ? d.roles.map((r) => `<span class="badge bg-info text-dark me-1">${esc(r)}</span>`).join('')
            : '<span class="text-muted">No roles assigned.</span>';
          const perms = d.isSuper
            ? 'Full access, including managing roles and accounts.'
            : (d.permissions.length ? d.permissions.map((p) => `<code class="me-1">${esc(p)}</code>`).join('') : 'No permissions.');
          out.innerHTML = `<div class="mb-2"><strong>${esc(d.username)}</strong>: ${roleBadges}</div><div class="small text-muted">Can do: ${perms}</div>`;
        })
        .catch((err) => { out.innerHTML = ''; fail('Could not load roles: ', err); });
    });

    $id('removeRoleUser').addEventListener('change', renderRemoveRoleOptions);
    $id('removeRoleForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const username = $id('removeRoleUser').value;
      const role = $id('removeRoleName').value;
      if (!username || !role) { showAlert('Select a user and a role first.', 'warning'); return; }
      jsonRequest(`/admin/staff/${encodeURIComponent(username)}/roles/${encodeURIComponent(role)}`, 'DELETE')
        .then(() => { showAlert(`"${role}" removed from ${username}.`, 'success'); loadRolesPage(); })
        .catch((err) => fail('Could not remove role: ', err));
    });
  });
})();

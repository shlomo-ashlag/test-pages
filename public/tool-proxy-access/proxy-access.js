// proxy access tool
// one board that answers: who may open the work apps through the qa proxy, which apps, and from
// which addresses. the users of the unit and the addresses of the access levels can be changed
// here, the apps are listed from the config
// everything runs in the browser: google sign-in gives an access token, the token stays in memory
// and goes only to the google apis below
(() => {
  "use strict";

  // none of these is a secret: the page is public, and so are they. the README tells where
  // each one comes from
  const config = {
    // oauth client id of the type "Web application"
    clientId: "556854096886-7v3li8qdv6qt2duv9h9n1o89ddp186oe.apps.googleusercontent.com",
    // number of the access policy, the page shows all the access levels of this policy
    policyId: "78929297567",
    // google gives no api to read where the access levels are assigned, so the next three values
    // are copied by hand from: admin console > security > context-aware access > assign access levels
    // path of the organizational unit the access levels are assigned to
    orgUnitPath: "/Users",
    // the apps they are assigned to for that unit
    apps: ["Calendar", "Drive and Docs", "FileCloud"],
    // the day the two values above were last compared with the admin console
    assignmentCheckedOn: "2026-11-12",
    // email of a google group to manage too. empty: the page has no part about a group
    groupEmail: "",
  };

  // the access levels need the wide cloud scope, google has no narrower one for them.
  // moving a user to another unit needs the scope that manages users
  const scopes = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/admin.directory.user",
    "https://www.googleapis.com/auth/admin.directory.orgunit.readonly",
    ...(config.groupEmail ? ["https://www.googleapis.com/auth/admin.directory.group.member"] : []),
  ];
  const directoryApi = "https://admin.googleapis.com/admin/directory/v1";
  const membersUrl = `${directoryApi}/groups/${encodeURIComponent(config.groupEmail)}/members`;
  const accessApi = "https://accesscontextmanager.googleapis.com/v1";
  const levelsUrl = `${accessApi}/accessPolicies/${encodeURIComponent(config.policyId)}/accessLevels`;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // what a condition of a level may check besides the address
  const otherChecks = {
    devicePolicy: "the device",
    regions: "the country",
    members: "the user",
    requiredAccessLevels: "other access levels",
    vpcNetworkSources: "VPC networks",
  };

  const state = {
    // google access token, it lives in this variable only and is gone when the page is closed
    token: "",
    // the access levels of the policy as google sent them, undefined until loaded
    levels: undefined,
    // paths of all organizational units and all users of the organization, undefined until loaded
    units: undefined,
    users: undefined,
    // the unit whose users the page shows
    unitPath: config.orgUnitPath,
    // the unit chosen in the row that moves a user
    moveTo: "",
    // the group members as google sent them, undefined until loaded
    members: undefined,
    // what is typed into the "add ip" fields, by level and condition: the fields are drawn again
    // on every change and must not lose the text
    drafts: {},
    // key of the row or tag that asks "remove?" or "move where?" now
    asking: "",
    busy: { level: false, users: false, members: false },
  };
  // grows on every sign-out, an answer that comes for an old session is dropped
  let session = 0;
  let tokenClient;

  const page = {
    setup: document.querySelector("[data-setup]"),
    signedOut: document.querySelector("[data-signed-out]"),
    signedIn: document.querySelector("[data-signed-in]"),
    signIn: document.querySelector("[data-sign-in]"),
    signOut: document.querySelector("[data-sign-out]"),
    refresh: document.querySelector("[data-refresh]"),
    unitSelect: document.querySelector("[data-unit-select]"),
    unitNote: document.querySelector("[data-unit-note]"),
    usersList: document.querySelector("[data-users-list]"),
    userForm: document.querySelector("[data-user-form]"),
    userInput: document.querySelector("[data-user-input]"),
    appsPart: document.querySelector("[data-apps-part]"),
    appsList: document.querySelector("[data-apps-list]"),
    appsNote: document.querySelector("[data-apps-note]"),
    levelList: document.querySelector("[data-level-list]"),
    membersPart: document.querySelector("[data-members-part]"),
    groupName: document.querySelector("[data-group-name]"),
    membersList: document.querySelector("[data-members-list]"),
    memberForm: document.querySelector("[data-member-form]"),
    memberInput: document.querySelector("[data-member-input]"),
  };

  const sleep = time => new Promise(resolve => setTimeout(resolve, time));
  const failure = (message, status) => Object.assign(new Error(message), { status });

  // name is "auth", "level", "users" or "members", kind is "ok", "bad" or "" for a neutral note
  function showStatus(name, kind, text) {
    const output = document.querySelector(`[data-status="${name}"]`);
    output.className = kind ? `status is-${kind}` : "status";
    output.textContent = text;
  }

  // one call to a google api with the token, answers with the parsed json
  // a failed call throws the reason google gives, this is what shows a missing role or api
  async function callGoogle(url, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${state.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw failure(`The request did not reach Google (${error.message}). Check the network, the browser console shows if it was blocked.`, 0);
    }
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // not json, the text itself goes to the message below
    }
    if (!response.ok) {
      const code = [response.status, data.error?.status].filter(Boolean).join(" ");
      const reason = data.error?.message || text.slice(0, 300) || response.statusText;
      throw failure(`Google answers ${code}: ${reason}`, response.status);
    }
    return data;
  }

  // google sends a long list in pages, this reads all of them. the url must have a query already
  async function fetchAll(url, listName) {
    const items = [];
    let pageToken = "";
    do {
      const data = await callGoogle(pageToken ? `${url}&pageToken=${encodeURIComponent(pageToken)}` : url);
      items.push(...(data[listName] ?? []));
      pageToken = data.nextPageToken ?? "";
    } while (pageToken);
    return items;
  }

  // runs one action of a part of the board: locks its controls, shows the progress, then the
  // result or the reason it failed. answers true when the action went through
  async function work(part, progress, task) {
    if (state.busy[part]) {
      return false;
    }
    const startedIn = session;
    state.busy[part] = true;
    // an open "remove?" may sit in another part, so everything is drawn again when there was one
    const wasAsking = state.asking;
    state.asking = "";
    if (wasAsking) {
      render();
    } else {
      painters[part]();
    }
    showStatus(part, "", progress);

    let result;
    try {
      result = { kind: "ok", text: await task() };
    } catch (error) {
      result = { kind: "bad", text: error.message, status: error.status };
    }
    if (startedIn !== session) {
      return false;
    }
    state.busy[part] = false;
    if (result.status === 401) {
      endSession("Google no longer accepts this sign-in, it lasts about an hour. Sign in again.");
      return false;
    }
    // only this part is drawn again, so typing in another part is not interrupted
    painters[part]();
    showStatus(part, result.text ? result.kind : "", result.text ?? "");
    return result.kind === "ok";
  }

  // sign-in

  function signIn() {
    const oauth = window.google?.accounts?.oauth2;
    if (!oauth) {
      showStatus("auth", "bad", "The Google sign-in script has not loaded. Check the network or an ad blocker, then reload the page.");
      return;
    }
    tokenClient ??= oauth.initTokenClient({
      client_id: config.clientId,
      scope: scopes.join(" "),
      callback: onToken,
      error_callback: onSignInError,
    });
    showStatus("auth", "", "");
    tokenClient.requestAccessToken();
  }

  function onToken(response) {
    if (response.error || !response.access_token) {
      showStatus("auth", "bad", `Google did not sign you in: ${response.error_description || response.error || "no token in the answer"}.`);
      return;
    }
    if (!window.google.accounts.oauth2.hasGrantedAllScopes(response, ...scopes)) {
      showStatus("auth", "bad", "Google gave only a part of the permissions. Sign in again and leave every box ticked.");
      return;
    }
    state.token = response.access_token;
    render();
    loadAll();
  }

  function onSignInError(error) {
    const reasons = {
      popup_failed_to_open: "The browser blocked the Google window. Allow pop-ups for this site and try again.",
      popup_closed: "The Google window was closed before the sign-in ended.",
    };
    showStatus("auth", "bad", reasons[error.type] ?? `Google sign-in failed: ${error.message || error.type}.`);
  }

  function signOut() {
    const token = state.token;
    endSession("");
    // the token stops working at google too, not only on this page
    window.google?.accounts?.oauth2?.revoke(token, () => {});
  }

  function endSession(message) {
    session++;
    state.token = "";
    state.levels = undefined;
    state.units = undefined;
    state.users = undefined;
    state.members = undefined;
    state.drafts = {};
    state.asking = "";
    state.busy = { level: false, users: false, members: false };
    showStatus("level", "", "");
    showStatus("users", "", "");
    showStatus("members", "", "");
    showStatus("auth", message ? "bad" : "", message);
    render();
  }

  function loadAll() {
    void loadLevels();
    void loadUsers();
    if (config.groupEmail) {
      void loadMembers();
    }
  }

  // access levels

  const levelLabel = level => level.title || level.name.split("/").pop();
  // a /32 is one address, it is shown without the suffix
  const addressLabel = subnet => (subnet.endsWith("/32") ? subnet.slice(0, -3) : subnet);

  // json of a value with the keys in a fixed order: google may send the same level with its
  // fields in another order, and that is not a change
  const canon = value =>
    JSON.stringify(value, (key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([first], [second]) => first.localeCompare(second)))
        : item,
    );

  const loadLevels = () =>
    work("level", "Loading the access levels...", async () => {
      state.levels = await fetchAll(`${levelsUrl}?pageSize=100`, "accessLevels");
    });

  function putLevel(level) {
    state.levels = (state.levels ?? []).map(item => (item.name === level.name ? level : item));
  }

  // the access level api answers with a long-running operation, the change is real only when
  // the operation is done
  async function waitFor(operation) {
    let current = operation;
    for (let attempt = 0; current.name && !current.done; attempt++) {
      if (attempt === 40) {
        throw failure("Google has not confirmed the change in a minute. Press Refresh a bit later to see if it went through.");
      }
      await sleep(1500);
      current = await callGoogle(`${accessApi}/${current.name}`);
    }
    if (current.error) {
      throw failure(`Google refused the change: ${current.error.message}`);
    }
  }

  // changes the addresses of one condition of a level. the api replaces the whole condition
  // list, so the level is read again first and everything else in it goes back as it was
  function changeAddresses(level, index, change, doneText) {
    const url = `${accessApi}/${level.name}`;
    return work("level", `Saving ${levelLabel(level)}. Google needs a few seconds to apply the change...`, async () => {
      const fresh = await callGoogle(url);
      if (canon(fresh.basic) !== canon(level.basic)) {
        putLevel(fresh);
        throw failure(`${levelLabel(level)} was changed somewhere else after this page loaded it. The page shows the new state now, check it and repeat.`);
      }
      const conditions = fresh.basic.conditions.map((condition, at) =>
        at === index ? { ...condition, ipSubnetworks: change(condition.ipSubnetworks ?? []) } : condition,
      );
      const operation = await callGoogle(`${url}?updateMask=basic.conditions`, {
        method: "PATCH",
        body: { basic: { conditions } },
      });
      await waitFor(operation);
      putLevel(await callGoogle(url));
      return doneText;
    });
  }

  // the reason an address cannot go to a level, "" when it can
  function addressProblem(address) {
    const parts = address.split(".");
    if (parts.length !== 4 || !parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) {
      return "is not an IPv4 address like 203.0.113.10: four numbers from 0 to 255.";
    }
    const [first, second] = parts.map(Number);
    const isPrivate =
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168);
    return isPrivate ? "is a private address. An access level takes public addresses only, enter the address the proxy has on the internet." : "";
  }

  // the field takes one address or several, split by spaces or commas, and saves them in one go
  async function addAddresses(level, index, draftKey) {
    const typed = [...new Set((state.drafts[draftKey] ?? "").split(/[\s,;]+/).filter(Boolean).map(addressLabel))];
    if (!typed.length) {
      showStatus("level", "bad", "Enter the address of the proxy, like 203.0.113.10. Several addresses go with spaces between them.");
      return;
    }
    for (const address of typed) {
      const problem = addressProblem(address);
      if (problem) {
        showStatus("level", "bad", `${address} ${problem}`);
        return;
      }
    }
    const present = (level.basic.conditions[index].ipSubnetworks ?? []).map(addressLabel);
    const added = typed.filter(address => !present.includes(address));
    if (!added.length) {
      showStatus("level", "ok", `${typed.join(", ")}: already in ${levelLabel(level)}.`);
      return;
    }
    const saved = await changeAddresses(
      level,
      index,
      list => [...list, ...added.map(address => `${address}/32`)],
      `${added.join(", ")}: added to ${levelLabel(level)}. It can take a few minutes before Google lets a new address in.`,
    );
    if (saved) {
      delete state.drafts[draftKey];
      renderLevels();
    }
  }

  // users and organizational units

  // a unit holds its own users and the users of the units under it, the settings of a unit act
  // on all of them
  const isUnder = (path, unit) => unit === "/" || path === unit || path.startsWith(`${unit}/`);
  const usersUnder = unit => (state.users ?? []).filter(user => isUnder(user.orgUnitPath ?? "/", unit));

  // all users are read at once and sorted into units on the page: the search of google by unit
  // is slow to notice a move
  const loadUsers = () =>
    work("users", "Loading the users...", async () => {
      const data = await callGoogle(`${directoryApi}/customer/my_customer/orgunits?type=all`);
      state.units = ["/", ...(data.organizationUnits ?? []).map(unit => unit.orgUnitPath)].sort();
      if (!state.units.includes(state.unitPath)) {
        state.unitPath = "/";
      }
      const fields = "nextPageToken,users(id,primaryEmail,name/fullName,orgUnitPath,suspended,isAdmin)";
      state.users = await fetchAll(
        `${directoryApi}/users?customer=my_customer&maxResults=500&orderBy=email&fields=${encodeURIComponent(fields)}`,
        "users",
      );
    });

  function chooseUnit() {
    state.unitPath = page.unitSelect.value;
    state.asking = "";
    showStatus("users", "", "");
    render();
  }

  // moves a user to a unit and puts the answer of google into the list on the page
  function moveUser(email, path) {
    return work("users", `Moving ${email} to ${path}...`, async () => {
      const moved = await callGoogle(`${directoryApi}/users/${encodeURIComponent(email)}`, {
        method: "PATCH",
        body: { orgUnitPath: path },
      });
      const user = { ...moved, primaryEmail: moved.primaryEmail ?? email, orgUnitPath: moved.orgUnitPath ?? path };
      const others = (state.users ?? []).filter(item => item.id !== user.id && item.primaryEmail !== user.primaryEmail);
      state.users = [...others, user];
      return `${user.primaryEmail} is now in ${user.orgUnitPath}. It can take a few minutes before Google applies the settings of the unit.`;
    });
  }

  function moveFromRow(user) {
    if (!state.moveTo) {
      showStatus("users", "bad", "Choose the unit to move the user to.");
      return;
    }
    void moveUser(user.primaryEmail, state.moveTo);
  }

  // the form under the list moves a user into the unit the page shows
  async function addUser() {
    const email = page.userInput.value.trim();
    if (!emailPattern.test(email)) {
      showStatus("users", "bad", "Enter an email like name@example.com.");
      return;
    }
    const present = (state.users ?? []).find(user => user.primaryEmail?.toLowerCase() === email.toLowerCase());
    if (present && present.orgUnitPath === state.unitPath) {
      showStatus("users", "ok", `${email} is already in ${state.unitPath}.`);
      return;
    }
    if (await moveUser(email, state.unitPath)) {
      page.userInput.value = "";
    }
  }

  // group members

  const fetchMembers = () => fetchAll(`${membersUrl}?maxResults=200`, "members");

  const loadMembers = () =>
    work("members", "Loading the group members...", async () => {
      state.members = await fetchMembers();
    });

  const memberLabel = member => member.email ?? "Everyone in the organization";

  function addMember() {
    const email = page.memberInput.value.trim();
    if (!emailPattern.test(email)) {
      showStatus("members", "bad", "Enter an email like name@example.com.");
      return;
    }
    void work("members", `Adding ${email}...`, async () => {
      let created;
      try {
        created = await callGoogle(membersUrl, { method: "POST", body: { email, role: "MEMBER" } });
      } catch (error) {
        // google answers 409 when the user is in the group already, so the goal is reached
        if (error.status !== 409) {
          throw error;
        }
        state.members = await fetchMembers();
        return `${email} is already in the group.`;
      }
      // the member list of google may lag behind for a moment, so the new member is put in by hand
      state.members = [...(state.members ?? []).filter(member => member.id !== created.id), created];
      page.memberInput.value = "";
      return `${email} is added to the group.`;
    });
  }

  function removeMember(member) {
    const label = memberLabel(member);
    void work("members", `Removing ${label}...`, async () => {
      await callGoogle(`${membersUrl}/${encodeURIComponent(member.id)}`, { method: "DELETE" });
      state.members = state.members.filter(item => item.id !== member.id);
      return `${label} is removed from the group.`;
    });
  }

  // page

  function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  function makeButton(text, className, disabled, onClick) {
    const button = make("button", `button button-small ${className}`, text);
    button.type = "button";
    button.disabled = disabled;
    button.addEventListener("click", onClick);
    return button;
  }

  function ask(key) {
    state.asking = key;
    render();
    document.querySelector(".is-asking button, .is-choosing select")?.focus();
  }

  // one address of a level: the address and a cross that asks once more before it removes
  function makeAddressTag(level, index, subnet, onlyOne, busy) {
    const key = `address:${level.name}:${index}:${subnet}`;
    const label = addressLabel(subnet);
    const tag = make("li", "tag");
    tag.append(make("code", "", label));
    if (state.asking === key) {
      tag.classList.add("is-asking");
      tag.append(
        makeButton("Remove", "button-danger", busy, () => {
          void changeAddresses(level, index, list => list.filter(item => item !== subnet), `${label}: removed from ${levelLabel(level)}.`);
        }),
        makeButton("Keep", "button-quiet", busy, () => ask("")),
      );
      return tag;
    }
    const cross = make("button", "tag-x", "×");
    cross.type = "button";
    cross.disabled = busy;
    cross.setAttribute("aria-label", `Remove ${label} from ${levelLabel(level)}`);
    // a condition left without addresses would stop checking the address at all
    cross.addEventListener("click", () => {
      if (onlyOne) {
        showStatus("level", "bad", `${label} is the only address of ${levelLabel(level)}. Add the new address first, then remove this one.`);
      } else {
        ask(key);
      }
    });
    tag.append(cross);
    return tag;
  }

  // one condition of a level: a line of its addresses with a field that adds more
  function makeCondition(level, condition, index, several, busy) {
    const line = make("div", "level-line");
    const subnets = condition.ipSubnetworks ?? [];
    const extra = Object.keys(otherChecks)
      .filter(name => condition[name] !== undefined)
      .map(name => otherChecks[name]);
    const notes = [
      several && `Condition ${index + 1}.`,
      condition.negate && "Turned around: it matches the requests that do not fit it.",
      extra.length && `Besides the address it also checks ${extra.join(", ")}.`,
      !subnets.length && "No addresses, so the address is not checked.",
    ].filter(Boolean);
    if (notes.length) {
      line.append(make("p", "hint", notes.join(" ")));
    }

    const tags = make("ul", "tags");
    for (const subnet of subnets) {
      tags.append(makeAddressTag(level, index, subnet, subnets.length === 1, busy));
    }

    const draftKey = `${level.name}:${index}`;
    const form = make("form", "mini-add");
    form.noValidate = true;
    const input = make("input");
    input.type = "text";
    input.placeholder = "Add IP";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.disabled = busy;
    input.value = state.drafts[draftKey] ?? "";
    input.setAttribute("aria-label", `Addresses to add to ${levelLabel(level)}`);
    input.addEventListener("input", () => {
      state.drafts[draftKey] = input.value;
    });
    const add = make("button", "button button-small", "Add");
    add.type = "submit";
    add.disabled = busy;
    form.append(input, add);
    form.addEventListener("submit", event => {
      event.preventDefault();
      void addAddresses(level, index, draftKey);
    });

    line.append(tags, form);
    return line;
  }

  function makeLevel(level, busy) {
    const block = make("div", "level");
    block.append(make("h3", "level-title", levelLabel(level)));
    if (level.custom) {
      block.append(
        make("p", "hint", "Written as an expression, so it cannot be changed here. Edit it in the Google Cloud console."),
        make("code", "", level.custom.expr?.expression ?? ""),
      );
      return block;
    }
    const conditions = level.basic?.conditions ?? [];
    const several = conditions.length > 1;
    if (several) {
      const rule = level.basic.combiningFunction === "OR" ? "any of its conditions matches" : "all of its conditions match";
      block.append(make("p", "hint", `A request passes this level when ${rule}.`));
    }
    conditions.forEach((condition, index) => {
      block.append(makeCondition(level, condition, index, several, busy));
    });
    return block;
  }

  function renderLevels() {
    const busy = state.busy.level;
    const levels = [...(state.levels ?? [])].sort((first, second) => levelLabel(first).localeCompare(levelLabel(second)));
    page.levelList.replaceChildren(...levels.map(level => makeLevel(level, busy)));
    if (state.levels && !levels.length) {
      page.levelList.append(make("p", "hint", "The policy has no access levels."));
    }
  }

  const unitLabel = path => (path === "/" ? "/ (the whole organization)" : path);

  // one user: the email, and a button that opens the choice of another unit
  function makeUserRow(user, busy) {
    const key = `user:${user.id}`;
    const row = make("li", "row");
    const main = make("div", "row-main");
    main.append(make("span", "row-value", user.primaryEmail));
    if (user.name?.fullName) {
      main.append(make("span", "muted", user.name.fullName));
    }
    // a user of a unit under the shown one is marked with the path of that unit
    const marks = [user.isAdmin && "admin", user.suspended && "suspended", user.orgUnitPath !== state.unitPath && user.orgUnitPath];
    for (const mark of marks.filter(Boolean)) {
      main.append(make("span", "chip", mark));
    }

    const actions = make("div", "row-actions");
    if (state.asking === key) {
      row.classList.add("is-choosing");
      const select = make("select", "row-select");
      select.setAttribute("aria-label", `Unit to move ${user.primaryEmail} to`);
      select.append(
        new Option("Move to...", ""),
        ...(state.units ?? []).filter(path => path !== user.orgUnitPath).map(path => new Option(unitLabel(path), path)),
      );
      select.value = state.moveTo;
      select.disabled = busy;
      // the choice is kept in the state, so a redraw of the page does not lose it
      select.addEventListener("change", () => {
        state.moveTo = select.value;
      });
      actions.append(
        select,
        makeButton("Move", "", busy, () => moveFromRow(user)),
        makeButton("Cancel", "button-quiet", busy, () => ask("")),
      );
    } else {
      actions.append(
        makeButton("Change unit", "button-quiet", busy, () => {
          state.moveTo = "";
          ask(key);
        }),
      );
    }
    row.append(main, actions);
    return row;
  }

  function renderUsers() {
    const busy = state.busy.users;
    const users = usersUnder(state.unitPath).sort((first, second) => first.primaryEmail.localeCompare(second.primaryEmail));
    // before the units are loaded the select shows the unit from the config alone
    page.unitSelect.replaceChildren(
      ...(state.units ?? [state.unitPath]).map(
        path => new Option(state.users ? `${unitLabel(path)} · ${usersUnder(path).length}` : unitLabel(path), path),
      ),
    );
    page.unitSelect.value = state.unitPath;
    page.unitSelect.disabled = busy;
    page.unitNote.textContent =
      state.unitPath === config.orgUnitPath
        ? "The access levels are assigned to this unit."
        : `The access levels are assigned to ${config.orgUnitPath}, this is another unit.`;
    page.usersList.replaceChildren();
    page.usersList.hidden = !state.users;

    if (!users.length) {
      page.usersList.append(make("li", "rows-empty", "No users in this unit."));
    }
    for (const user of users) {
      page.usersList.append(makeUserRow(user, busy));
    }
    for (const control of page.userForm.elements) {
      control.disabled = busy;
    }
  }

  // one member of the group: the email and a remove button that asks once more before it acts
  function makeMemberRow(member, busy) {
    const key = `member:${member.id}`;
    const row = make("li", "row");
    const main = make("div", "row-main");
    main.append(make("span", "row-value", memberLabel(member)));
    // owners, managers and nested groups are marked, a plain user is not
    for (const mark of [member.role, member.type]) {
      if (mark && mark !== "MEMBER" && mark !== "USER") {
        main.append(make("span", "chip", mark.toLowerCase()));
      }
    }
    const actions = make("div", "row-actions");
    if (state.asking === key) {
      row.classList.add("is-asking");
      actions.append(
        makeButton("Yes, remove", "button-danger", busy, () => removeMember(member)),
        makeButton("Cancel", "button-quiet", busy, () => ask("")),
      );
    } else {
      actions.append(makeButton("Remove", "button-quiet", busy, () => ask(key)));
    }
    row.append(main, actions);
    return row;
  }

  function renderMembers() {
    const busy = state.busy.members;
    const members = [...(state.members ?? [])].sort((first, second) => memberLabel(first).localeCompare(memberLabel(second)));
    page.groupName.textContent = config.groupEmail;
    page.membersList.replaceChildren();
    page.membersList.hidden = !state.members;

    if (!members.length) {
      page.membersList.append(make("li", "rows-empty", "The group has no members."));
    }
    for (const member of members) {
      page.membersList.append(makeMemberRow(member, busy));
    }
    for (const control of page.memberForm.elements) {
      control.disabled = busy;
    }
  }

  // the apps come from the config, google has no api for them, so they are drawn once
  function renderApps() {
    page.appsPart.hidden = !config.apps.length;
    page.appsList.replaceChildren(...config.apps.map(name => make("li", "tag tag-plain", name)));
    page.appsNote.textContent = `Copied by hand on ${config.assignmentCheckedOn}: Google does not let this page read it. The source is Admin console > Security > Context-Aware Access > Assign access levels.`;
  }

  const painters = { level: renderLevels, users: renderUsers, members: renderMembers };

  function render() {
    const signedIn = Boolean(state.token);
    page.signedOut.hidden = signedIn;
    page.signedIn.hidden = !signedIn;
    // without a group in the config the board has no part about the group
    page.membersPart.hidden = !config.groupEmail;
    renderLevels();
    renderUsers();
    renderMembers();
  }

  page.signIn.addEventListener("click", signIn);
  page.signOut.addEventListener("click", signOut);
  page.refresh.addEventListener("click", loadAll);
  page.unitSelect.addEventListener("change", chooseUnit);
  page.userForm.addEventListener("submit", event => {
    event.preventDefault();
    void addUser();
  });
  page.memberForm.addEventListener("submit", event => {
    event.preventDefault();
    addMember();
  });

  const missing = ["clientId", "policyId"].filter(name => !config[name]);
  if (missing.length) {
    page.setup.textContent = `This page is not set up yet. Fill in ${missing.join(", ")} at the top of public/tool-proxy-access/proxy-access.js, the README tells where to get them.`;
    page.setup.hidden = false;
    page.signIn.disabled = true;
  }
  renderApps();
  render();
})();

// proxy access tool
// shows who is in the google group and which addresses the access level lets in, and changes both
// everything runs in the browser: google sign-in gives an access token, the token stays in memory
// and goes only to the two google apis below
(() => {
  "use strict";

  // fill these in before the first use, the README tells where each one comes from
  // none of them is a secret: the page is public, and so are they
  const config = {
    // oauth client id of the type "Web application"
    clientId: "",
    // email of the google group that opens the work apps
    groupEmail: "",
    // number of the access policy
    policyId: "",
    // short name of the access level in the policy, not its title
    accessLevelName: "",
    // the "User email" field starts with this email
    defaultUserEmail: "john@pp-testing.com",
  };

  const scopes = [
    "https://www.googleapis.com/auth/admin.directory.group.member",
    "https://www.googleapis.com/auth/cloud-platform",
  ];
  const membersUrl = `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(config.groupEmail)}/members`;
  const accessApi = "https://accesscontextmanager.googleapis.com/v1";
  const levelUrl = `${accessApi}/accessPolicies/${encodeURIComponent(config.policyId)}/accessLevels/${encodeURIComponent(config.accessLevelName)}`;

  // what a condition of the level may check besides the address
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
    // the access level and the group members as google sent them, undefined until loaded
    level: undefined,
    members: undefined,
    // key of the row that asks "remove?" now
    asking: "",
    busy: { level: false, members: false },
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
    levelTitle: document.querySelector("[data-level-title]"),
    levelList: document.querySelector("[data-level-list]"),
    addressForm: document.querySelector("[data-address-form]"),
    addressInput: document.querySelector("[data-address-input]"),
    conditionField: document.querySelector("[data-condition-field]"),
    conditionSelect: document.querySelector("[data-condition-select]"),
    groupName: document.querySelector("[data-group-name]"),
    membersList: document.querySelector("[data-members-list]"),
    memberForm: document.querySelector("[data-member-form]"),
    memberInput: document.querySelector("[data-member-input]"),
  };

  const sleep = time => new Promise(resolve => setTimeout(resolve, time));
  const failure = (message, status) => Object.assign(new Error(message), { status });

  // name is "auth", "level" or "members", kind is "ok", "bad" or "" for a neutral note
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

  // runs one action of a section: locks its buttons, shows the progress, then the result or the
  // reason it failed. answers true when the action went through
  async function work(section, progress, task) {
    if (state.busy[section]) {
      return false;
    }
    const startedIn = session;
    state.busy[section] = true;
    state.asking = "";
    render();
    showStatus(section, "", progress);

    let result;
    try {
      result = { kind: "ok", text: await task() };
    } catch (error) {
      result = { kind: "bad", text: error.message, status: error.status };
    }
    if (startedIn !== session) {
      return false;
    }
    state.busy[section] = false;
    if (result.status === 401) {
      endSession("Google no longer accepts this sign-in, it lasts about an hour. Sign in again.");
      return false;
    }
    render();
    showStatus(section, result.text ? result.kind : "", result.text ?? "");
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
      showStatus("auth", "bad", "Google gave only a part of the permissions. Sign in again and leave both boxes ticked.");
      return;
    }
    state.token = response.access_token;
    render();
    void loadLevel();
    void loadMembers();
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
    state.level = undefined;
    state.members = undefined;
    state.asking = "";
    state.busy = { level: false, members: false };
    showStatus("level", "", "");
    showStatus("members", "", "");
    showStatus("auth", message ? "bad" : "", message);
    render();
  }

  // access level

  const loadLevel = () =>
    work("level", "Loading the access level...", async () => {
      state.level = await callGoogle(levelUrl);
    });

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

  // changes the addresses of one condition. the api replaces the whole condition list, so the
  // level is read again first and everything else in it goes back as it was
  function changeAddresses(index, change, doneText) {
    return work("level", "Saving. Google needs a few seconds to apply the change...", async () => {
      const fresh = await callGoogle(levelUrl);
      if (JSON.stringify(fresh.basic) !== JSON.stringify(state.level.basic)) {
        state.level = fresh;
        throw failure("The access level was changed somewhere else after this page loaded it. The list is up to date now, check it and repeat.");
      }
      const conditions = fresh.basic.conditions.map((condition, at) =>
        at === index ? { ...condition, ipSubnetworks: change(condition.ipSubnetworks ?? []) } : condition,
      );
      const operation = await callGoogle(`${levelUrl}?updateMask=basic.conditions`, {
        method: "PATCH",
        body: { basic: { conditions } },
      });
      await waitFor(operation);
      state.level = await callGoogle(levelUrl);
      return doneText;
    });
  }

  // the reason an address cannot go to the level, "" when it can
  function addressProblem(address) {
    const parts = address.split(".");
    if (parts.length !== 4 || !parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) {
      return "Enter an IPv4 address like 203.0.113.10: four numbers from 0 to 255.";
    }
    const [first, second] = parts.map(Number);
    const isPrivate =
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168);
    return isPrivate ? "This is a private address. An access level takes public addresses only, enter the address the proxy has on the internet." : "";
  }

  async function addAddress() {
    const address = page.addressInput.value.trim();
    const index = Number(page.conditionSelect.value) || 0;
    const problem = addressProblem(address);
    if (problem) {
      showStatus("level", "bad", problem);
      return;
    }
    const subnet = `${address}/32`;
    const present = state.level.basic.conditions[index].ipSubnetworks ?? [];
    if (present.includes(subnet) || present.includes(address)) {
      showStatus("level", "ok", `${address} is already in the list.`);
      return;
    }
    const added = await changeAddresses(
      index,
      list => [...list, subnet],
      `${subnet} is added. It can take a few minutes before Google lets this address in.`,
    );
    if (added) {
      page.addressInput.value = "";
    }
  }

  const removeAddress = (index, subnet) =>
    changeAddresses(index, list => list.filter(item => item !== subnet), `${subnet} is removed.`);

  // group members

  // google sends the members in pages
  async function fetchMembers() {
    const members = [];
    let pageToken = "";
    do {
      const next = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const data = await callGoogle(`${membersUrl}?maxResults=200${next}`);
      members.push(...(data.members ?? []));
      pageToken = data.nextPageToken ?? "";
    } while (pageToken);
    return members;
  }

  const loadMembers = () =>
    work("members", "Loading the group members...", async () => {
      state.members = await fetchMembers();
    });

  const memberLabel = member => member.email ?? "Everyone in the organization";

  function addMember() {
    const email = page.memberInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
    document.querySelector(".row.is-asking button")?.focus();
  }

  // one line of a list: the value and a remove button that asks once more before it acts
  function makeRow(key, content, busy, onRemove, onAsk = () => ask(key)) {
    const row = make("li", "row");
    const main = make("div", "row-main");
    main.append(...content);
    const actions = make("div", "row-actions");
    if (state.asking === key) {
      row.classList.add("is-asking");
      actions.append(
        makeButton("Yes, remove", "button-danger", busy, onRemove),
        makeButton("Cancel", "button-quiet", busy, () => ask("")),
      );
    } else {
      actions.append(makeButton("Remove", "button-quiet", busy, onAsk));
    }
    row.append(main, actions);
    return row;
  }

  function lock(form, busy) {
    for (const control of form.elements) {
      control.disabled = busy;
    }
  }

  function makeCondition(condition, index, several, busy) {
    const group = make("div", "group");
    const subnets = condition.ipSubnetworks ?? [];
    const extra = Object.keys(otherChecks)
      .filter(name => condition[name] !== undefined)
      .map(name => otherChecks[name]);
    if (several) {
      group.append(make("h3", "group-title", `Condition ${index + 1}`));
    }
    if (condition.negate) {
      group.append(make("p", "group-note", "This condition is turned around: it matches the requests that do not fit it."));
    }
    if (extra.length) {
      group.append(make("p", "group-note", `Besides the address it also checks ${extra.join(", ")}.`));
    }

    const list = make("ul", "rows");
    if (!subnets.length) {
      list.append(make("li", "rows-empty", "No addresses. This condition does not look at the address."));
    }
    for (const subnet of subnets) {
      // a condition left without addresses would stop checking the address at all
      const refuse = () =>
        showStatus("level", "bad", "This is the only address of the condition. Add the new address first, then remove this one.");
      list.append(
        makeRow(
          `address:${index}:${subnet}`,
          [make("code", "", subnet)],
          busy,
          () => void removeAddress(index, subnet),
          subnets.length === 1 ? refuse : undefined,
        ),
      );
    }
    group.append(list);
    return group;
  }

  function renderLevel() {
    const busy = state.busy.level;
    const level = state.level;
    const conditions = level?.basic?.conditions ?? [];
    const several = conditions.length > 1;
    page.levelTitle.textContent = level?.title ? `${level.title} (${config.accessLevelName})` : config.accessLevelName;
    page.levelList.replaceChildren();

    if (level?.custom) {
      page.levelList.append(
        make("p", "panel-text", "This level is written as an expression, so it cannot be changed here. Edit it in the Google Cloud console."),
        make("code", "", level.custom.expr?.expression ?? ""),
      );
    }
    if (several) {
      const rule = level.basic.combiningFunction === "OR" ? "any of these conditions matches" : "all of these conditions match";
      page.levelList.append(make("p", "panel-text", `A request gets in when ${rule}.`));
    }
    conditions.forEach((condition, index) => {
      page.levelList.append(makeCondition(condition, index, several, busy));
    });

    const chosen = Number(page.conditionSelect.value) || 0;
    page.conditionSelect.replaceChildren(...conditions.map((_, index) => new Option(`Condition ${index + 1}`, String(index))));
    page.conditionSelect.value = String(chosen < conditions.length ? chosen : 0);
    page.conditionField.hidden = !several;
    page.addressForm.hidden = !conditions.length;
    lock(page.addressForm, busy);
    document.querySelector('[data-refresh="level"]').disabled = busy;
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
      const content = [make("span", "row-value", memberLabel(member))];
      // owners, managers and nested groups are marked, a plain user is not
      for (const mark of [member.role, member.type]) {
        if (mark && mark !== "MEMBER" && mark !== "USER") {
          content.push(make("span", "chip", mark.toLowerCase()));
        }
      }
      page.membersList.append(makeRow(`member:${member.id}`, content, busy, () => removeMember(member)));
    }
    lock(page.memberForm, busy);
    document.querySelector('[data-refresh="members"]').disabled = busy;
  }

  function render() {
    const signedIn = Boolean(state.token);
    page.signedOut.hidden = signedIn;
    page.signedIn.hidden = !signedIn;
    renderLevel();
    renderMembers();
  }

  const loaders = { level: loadLevel, members: loadMembers };
  for (const button of document.querySelectorAll("[data-refresh]")) {
    button.addEventListener("click", () => void loaders[button.dataset.refresh]());
  }
  page.signIn.addEventListener("click", signIn);
  page.signOut.addEventListener("click", signOut);
  page.addressForm.addEventListener("submit", event => {
    event.preventDefault();
    void addAddress();
  });
  page.memberForm.addEventListener("submit", event => {
    event.preventDefault();
    addMember();
  });

  const missing = ["clientId", "groupEmail", "policyId", "accessLevelName"].filter(name => !config[name]);
  if (missing.length) {
    page.setup.textContent = `This page is not set up yet. Fill in ${missing.join(", ")} at the top of public/tool-proxy-access/proxy-access.js, the README tells where to get them.`;
    page.setup.hidden = false;
    page.signIn.disabled = true;
  }
  page.memberInput.value = config.defaultUserEmail;
  render();
})();

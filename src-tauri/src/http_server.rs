use crate::agent_types::*;
use crate::browser::{
    BrowserActionCallback, BrowserConsoleEvent, BrowserConsoleFilter, BrowserImageFormat,
    BrowserManager, BrowserNetworkEvent, BrowserNetworkFilter,
};
use crate::database::AgentDatabase;
use axum::{
    extract::{Form, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{delete, get, patch, post, put},
    Json, Router,
};
use serde::Deserialize;
use std::net::TcpListener;
use std::sync::Arc;

/// Shared state for the HTTP server
pub struct AppState {
    pub db: Arc<AgentDatabase>,
    pub browser: Arc<BrowserManager>,
}

/// Start the HTTP server on the specified port
pub async fn start_server(
    listener: TcpListener,
    db: Arc<AgentDatabase>,
    browser: Arc<BrowserManager>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let state = Arc::new(AppState { db, browser });

    let app = Router::new()
        // Browser routes
        .route("/browser/:id/open", post(browser_open))
        .route("/browser/:id/close", post(browser_close))
        .route("/browser/:id/show", post(browser_show))
        .route("/browser/:id/hide", post(browser_hide))
        .route("/browser/:id/navigate", post(browser_navigate))
        .route("/browser/:id/reload", post(browser_reload))
        .route("/browser/:id/back", post(browser_back))
        .route("/browser/:id/forward", post(browser_forward))
        .route("/browser/:id/click", post(browser_click))
        .route("/browser/:id/type", post(browser_type))
        .route("/browser/:id/press", post(browser_press))
        .route("/browser/:id/wait-for", post(browser_wait_for))
        .route("/browser/:id/console", get(browser_console_get))
        .route("/browser/:id/console/clear", post(browser_console_clear))
        .route("/browser/:id/network", get(browser_network_get))
        .route("/browser/:id/network/clear", post(browser_network_clear))
        .route("/browser/:id/state", get(browser_state))
        .route("/browser/:id/html", get(browser_html))
        .route("/browser/:id/snapshot", get(browser_snapshot))
        .route("/browser/callback", post(browser_callback))
        .route("/browser/console", post(browser_console))
        .route("/browser/network", post(browser_network))
        // Agent routes
        .route("/agents", get(list_agents))
        .route("/agents/register", post(register_agent))
        .route("/agents/:id", get(get_agent))
        .route("/agents/:id", patch(update_agent))
        .route("/agents/:id", delete(unregister_agent))
        .route("/agents/:id/heartbeat", post(heartbeat))
        // Message routes
        .route("/messages/inbox", get(get_inbox))
        .route("/messages/ask", post(ask_message))
        .route("/messages/broadcast", post(broadcast_message))
        .route("/messages/:id", get(get_message))
        .route("/messages/:id/respond", post(respond_to_message))
        .route("/messages/:id/read", post(mark_message_read))
        // Task routes
        .route("/tasks", get(list_tasks))
        .route("/tasks", post(create_task))
        .route("/tasks/:id", get(get_task))
        .route("/tasks/:id", patch(update_task))
        .route("/tasks/:id/claim", post(claim_task))
        // Context routes
        .route("/context", get(list_context))
        .route("/context/:key", get(get_context))
        .route("/context/:key", put(set_context))
        .route("/context/:key", delete(delete_context))
        // Health check
        .route("/health", get(health_check))
        .with_state(state);

    let addr = listener.local_addr()?;
    println!("Agent API server starting on http://{}", addr);

    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to set HTTP listener nonblocking: {e}"))?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    axum::serve(listener, app).await?;

    Ok(())
}

// ============================================================================
// Health Check
// ============================================================================

async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok" }))
}

// ============================================================================
// Browser Handlers
// ============================================================================

#[derive(Deserialize)]
struct BrowserAuthQuery {
    token: String,
}

#[derive(Deserialize)]
struct BrowserOpenForm {
    token: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct BrowserNavigateForm {
    token: String,
    url: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct BrowserSelectorForm {
    token: String,
    selector: String,
}

#[derive(Deserialize)]
struct BrowserTypeForm {
    token: String,
    selector: String,
    text: String,
}

#[derive(Deserialize)]
struct BrowserPressForm {
    token: String,
    key: String,
}

#[derive(Deserialize)]
struct BrowserWaitForForm {
    token: String,
    selector: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
struct BrowserSnapshotQuery {
    token: String,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    format: Option<String>,
}

#[derive(Deserialize)]
struct BrowserConsoleQuery {
    token: String,
    #[serde(default)]
    level: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct BrowserNetworkQuery {
    token: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn browser_open(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Form(form): Form<BrowserOpenForm>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &form.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    if let Err(err) = state
        .browser
        .register_session_directory(&id, form.cwd.as_deref())
    {
        return error_json(StatusCode::INTERNAL_SERVER_ERROR, err);
    }
    match state.browser.open(&id, form.url) {
        Ok(browser_state) => ok_json(browser_state),
        Err(err) => error_json(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

async fn browser_close(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Form(form): Form<BrowserAuthQuery>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &form.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    match state.browser.close(&id) {
        Ok(()) => ok_json(serde_json::json!({ "success": true })),
        Err(err) => error_json(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

async fn browser_show(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Form(form): Form<BrowserAuthQuery>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &form.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    match state.browser.set_pane_open(&id, true) {
        Ok(browser_state) => ok_json(browser_state),
        Err(err) => error_json(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

async fn browser_hide(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Form(form): Form<BrowserAuthQuery>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &form.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    match state.browser.set_pane_open(&id, false) {
        Ok(browser_state) => ok_json(browser_state),
        Err(err) => error_json(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

async fn browser_navigate(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Form(form): Form<BrowserNavigateForm>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &form.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    if let Err(err) = state
        .browser
        .register_session_directory(&id, form.cwd.as_deref())
    {
        return error_json(StatusCode::INTERNAL_SERVER_ERROR, err);
    }
    match state.browser.navigate(&id, &form.url) {
        Ok(browser_state) => ok_json(browser_state),
        Err(err) => error_json(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

async fn browser_reload(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Form(form): Form<BrowserAuthQuery>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &form.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    match state.browser.reload(&id) {
        Ok(browser_state) => ok_json(browser_state),
        Err(err) => error_json(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

async fn browser_back(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Form(form): Form<BrowserAuthQuery>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &form.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    match state.browser.go_back(&id) {
        Ok(browser_state) => ok_json(browser_state),
        Err(err) => error_json(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

async fn browser_forward(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Form(form): Form<BrowserAuthQuery>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &form.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    match state.browser.go_forward(&id) {
        Ok(browser_state) => ok_json(browser_state),
        Err(err) => error_json(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

async fn browser_click(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Form(form): Form<BrowserSelectorForm>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &form.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    match state.browser.click(&id, &form.selector) {
        Ok(result) => ok_json(result),
        Err(err) => error_json(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

async fn browser_type(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Form(form): Form<BrowserTypeForm>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &form.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    match state.browser.type_text(&id, &form.selector, &form.text) {
        Ok(result) => ok_json(result),
        Err(err) => error_json(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

async fn browser_press(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Form(form): Form<BrowserPressForm>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &form.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    match state.browser.press_key(&id, &form.key) {
        Ok(result) => ok_json(result),
        Err(err) => error_json(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

async fn browser_wait_for(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Form(form): Form<BrowserWaitForForm>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &form.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    match state
        .browser
        .wait_for(&id, &form.selector, form.timeout_ms.unwrap_or(10_000))
    {
        Ok(result) => ok_json(result),
        Err(err) => error_json(StatusCode::REQUEST_TIMEOUT, err),
    }
}

async fn browser_state(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<BrowserAuthQuery>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &query.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    match state.browser.get_state(&id) {
        Ok(browser_state) => ok_json(browser_state),
        Err(err) => error_json(StatusCode::NOT_FOUND, err),
    }
}

async fn browser_console_get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<BrowserConsoleQuery>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &query.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    let filter = match BrowserConsoleFilter::from_query(query.level.as_deref()) {
        Ok(filter) => filter,
        Err(err) => return error_json(StatusCode::BAD_REQUEST, err),
    };
    match state
        .browser
        .get_console_entries(&id, filter, query.limit.unwrap_or(100))
    {
        Ok(entries) => ok_json(entries),
        Err(err) => error_json(StatusCode::NOT_FOUND, err),
    }
}

async fn browser_console_clear(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Form(form): Form<BrowserAuthQuery>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &form.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    match state.browser.clear_console_entries(&id) {
        Ok(()) => ok_json(serde_json::json!({ "success": true })),
        Err(err) => error_json(StatusCode::NOT_FOUND, err),
    }
}

async fn browser_network_get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<BrowserNetworkQuery>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &query.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    let filter = match BrowserNetworkFilter::from_query(query.kind.as_deref()) {
        Ok(filter) => filter,
        Err(err) => return error_json(StatusCode::BAD_REQUEST, err),
    };
    match state
        .browser
        .get_network_entries(&id, filter, query.limit.unwrap_or(100))
    {
        Ok(entries) => ok_json(entries),
        Err(err) => error_json(StatusCode::NOT_FOUND, err),
    }
}

async fn browser_network_clear(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Form(form): Form<BrowserAuthQuery>,
) -> impl IntoResponse {
    if let Err(err) = state.browser.validate_token(&id, &form.token) {
        return error_json(StatusCode::UNAUTHORIZED, err);
    }
    match state.browser.clear_network_entries(&id) {
        Ok(()) => ok_json(serde_json::json!({ "success": true })),
        Err(err) => error_json(StatusCode::NOT_FOUND, err),
    }
}

async fn browser_html(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<BrowserAuthQuery>,
) -> Response {
    if let Err(err) = state.browser.validate_token(&id, &query.token) {
        return error_json(StatusCode::UNAUTHORIZED, err).into_response();
    }
    match state.browser.snapshot_dom(&id) {
        Ok(snapshot) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            );
            (StatusCode::OK, headers, Html(snapshot.html)).into_response()
        }
        Err(err) => error_json(StatusCode::INTERNAL_SERVER_ERROR, err).into_response(),
    }
}

async fn browser_snapshot(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<BrowserSnapshotQuery>,
) -> Response {
    if let Err(err) = state.browser.validate_token(&id, &query.token) {
        return error_json(StatusCode::UNAUTHORIZED, err).into_response();
    }
    match query.mode.as_deref().unwrap_or("dom") {
        "image" => match BrowserImageFormat::from_query(query.format.as_deref()) {
            Ok(format) => match state.browser.snapshot_image(&id, format) {
                Ok(bytes) => {
                    let mut headers = HeaderMap::new();
                    headers.insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static(format.content_type()),
                    );
                    (StatusCode::OK, headers, bytes).into_response()
                }
                Err(err) => error_json(StatusCode::INTERNAL_SERVER_ERROR, err).into_response(),
            },
            Err(err) => error_json(StatusCode::BAD_REQUEST, err).into_response(),
        },
        _ => match state.browser.snapshot_dom(&id) {
            Ok(snapshot) => ok_json(snapshot).into_response(),
            Err(err) => error_json(StatusCode::INTERNAL_SERVER_ERROR, err).into_response(),
        },
    }
}

async fn browser_callback(State(state): State<Arc<AppState>>, body: String) -> impl IntoResponse {
    match serde_json::from_str::<BrowserActionCallback>(&body) {
        Ok(payload) => match state.browser.resolve_callback(payload) {
            Ok(()) => (StatusCode::OK, "ok").into_response(),
            Err(err) => (StatusCode::BAD_REQUEST, err).into_response(),
        },
        Err(err) => (
            StatusCode::BAD_REQUEST,
            format!("Invalid browser callback payload: {err}"),
        )
            .into_response(),
    }
}

async fn browser_console(State(state): State<Arc<AppState>>, body: String) -> impl IntoResponse {
    match serde_json::from_str::<BrowserConsoleEvent>(&body) {
        Ok(payload) => match state.browser.record_console_event(payload) {
            Ok(()) => (StatusCode::OK, "ok").into_response(),
            Err(err) => (StatusCode::BAD_REQUEST, err).into_response(),
        },
        Err(err) => (
            StatusCode::BAD_REQUEST,
            format!("Invalid browser console payload: {err}"),
        )
            .into_response(),
    }
}

async fn browser_network(State(state): State<Arc<AppState>>, body: String) -> impl IntoResponse {
    match serde_json::from_str::<BrowserNetworkEvent>(&body) {
        Ok(payload) => match state.browser.record_network_event(payload) {
            Ok(()) => (StatusCode::OK, "ok").into_response(),
            Err(err) => (StatusCode::BAD_REQUEST, err).into_response(),
        },
        Err(err) => (
            StatusCode::BAD_REQUEST,
            format!("Invalid browser network payload: {err}"),
        )
            .into_response(),
    }
}

fn ok_json<T: serde::Serialize>(value: T) -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::OK, Json(serde_json::json!(value)))
}

fn error_json(
    status: StatusCode,
    error: impl Into<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(serde_json::json!({ "error": error.into() })))
}

// ============================================================================
// Agent Handlers
// ============================================================================

async fn list_agents(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.db.list_agents() {
        Ok(agents) => (
            StatusCode::OK,
            Json(serde_json::json!({ "agents": agents })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn register_agent(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterAgentRequest>,
) -> impl IntoResponse {
    match state.db.register_agent(&req) {
        Ok(agent_id) => (
            StatusCode::CREATED,
            Json(serde_json::json!({
                "agent_id": agent_id,
                "success": true
            })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e, "success": false })),
        ),
    }
}

async fn get_agent(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.db.get_agent(&id) {
        Ok(Some(agent)) => (StatusCode::OK, Json(serde_json::json!(agent))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Agent not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn update_agent(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<UpdateAgentRequest>,
) -> impl IntoResponse {
    match state.db.update_agent(&id, &req) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn unregister_agent(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.db.unregister_agent(&id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn heartbeat(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.db.heartbeat(&id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

// ============================================================================
// Message Handlers
// ============================================================================

#[derive(Deserialize)]
struct InboxQuery {
    agent_id: String,
    #[serde(default)]
    status: Option<String>,
}

async fn get_inbox(
    State(state): State<Arc<AppState>>,
    Query(query): Query<InboxQuery>,
) -> impl IntoResponse {
    match state.db.get_inbox(&query.agent_id, query.status.as_deref()) {
        Ok(messages) => (
            StatusCode::OK,
            Json(serde_json::json!({ "messages": messages })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn ask_message(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AskMessageRequest>,
) -> impl IntoResponse {
    // First resolve the target agent (by ID or name)
    let target_agent = match state.db.get_agent(&req.to) {
        Ok(Some(agent)) => agent,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": format!("Agent '{}' not found", req.to) })),
            );
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e })),
            );
        }
    };

    // Create the message
    let message_id = match state.db.create_message(
        &req.from,
        Some(&target_agent.id),
        MessageType::Ask,
        &req.message,
        req.context.as_ref(),
    ) {
        Ok(id) => id,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e })),
            );
        }
    };

    // If wait_for_response is true, block until we get a response
    if req.wait_for_response {
        match state.db.wait_for_response(message_id, req.timeout_seconds) {
            Ok(Some(response)) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "message_id": message_id,
                    "response": response
                })),
            ),
            Ok(None) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "message_id": message_id,
                    "response": null,
                    "timeout": true
                })),
            ),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e })),
            ),
        }
    } else {
        (
            StatusCode::OK,
            Json(serde_json::json!({ "message_id": message_id })),
        )
    }
}

async fn broadcast_message(
    State(state): State<Arc<AppState>>,
    Json(req): Json<BroadcastRequest>,
) -> impl IntoResponse {
    match state
        .db
        .create_message(&req.from, None, MessageType::Notify, &req.message, None)
    {
        Ok(message_id) => (
            StatusCode::OK,
            Json(serde_json::json!({ "message_id": message_id })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn get_message(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> impl IntoResponse {
    match state.db.get_message(id) {
        Ok(Some(message)) => (StatusCode::OK, Json(serde_json::json!(message))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Message not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn respond_to_message(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(req): Json<RespondMessageRequest>,
) -> impl IntoResponse {
    match state.db.respond_to_message(id, &req.from, &req.response) {
        Ok(response_id) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "response_id": response_id,
                "success": true
            })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn mark_message_read(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    match state.db.mark_message_read(id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

// ============================================================================
// Task Handlers
// ============================================================================

#[derive(Deserialize)]
struct TaskQuery {
    #[serde(default)]
    assigned_to: Option<String>,
    #[serde(default)]
    assigned_by: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

async fn list_tasks(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TaskQuery>,
) -> impl IntoResponse {
    match state.db.list_tasks(
        query.assigned_to.as_deref(),
        query.assigned_by.as_deref(),
        query.status.as_deref(),
    ) {
        Ok(tasks) => (StatusCode::OK, Json(serde_json::json!({ "tasks": tasks }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn create_task(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateTaskRequest>,
) -> impl IntoResponse {
    match state.db.create_task(&req) {
        Ok(task_id) => (
            StatusCode::CREATED,
            Json(serde_json::json!({ "task_id": task_id })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn get_task(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> impl IntoResponse {
    match state.db.get_task(&id) {
        Ok(Some(task)) => (StatusCode::OK, Json(serde_json::json!(task))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Task not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn update_task(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<UpdateTaskRequest>,
) -> impl IntoResponse {
    match state.db.update_task(&id, &req) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn claim_task(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<ClaimTaskRequest>,
) -> impl IntoResponse {
    match state.db.claim_task(&id, &req.agent_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

// ============================================================================
// Context Handlers
// ============================================================================

async fn list_context(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.db.list_context() {
        Ok(contexts) => (
            StatusCode::OK,
            Json(serde_json::json!({ "context": contexts })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn get_context(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> impl IntoResponse {
    match state.db.get_context(&key) {
        Ok(Some(ctx)) => (StatusCode::OK, Json(serde_json::json!(ctx))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Context key not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn set_context(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    Json(req): Json<SetContextRequest>,
) -> impl IntoResponse {
    match state
        .db
        .set_context(&key, &req.value, req.set_by.as_deref())
    {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn delete_context(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> impl IntoResponse {
    match state.db.delete_context(&key) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

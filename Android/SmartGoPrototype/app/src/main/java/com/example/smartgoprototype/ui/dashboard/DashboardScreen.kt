package com.example.smartgoprototype.ui.dashboard

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.ExperimentalMaterialApi
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.pullrefresh.PullRefreshIndicator
import androidx.compose.material.pullrefresh.pullRefresh
import androidx.compose.material.pullrefresh.rememberPullRefreshState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.example.smartgoprototype.domain.model.ForecastStatus
import com.example.smartgoprototype.domain.model.Route
import com.example.smartgoprototype.domain.model.RouteForecast
import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import kotlinx.coroutines.delay
import sh.calvin.reorderable.ReorderableItem
import sh.calvin.reorderable.rememberReorderableLazyListState

@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterialApi::class)
@Composable
fun DashboardScreen(
    uiState: DashboardUiState,
    onAddRouteClick: () -> Unit,
    onRefresh: () -> Unit,
    onLogoutClick: () -> Unit,
    onEditRoute: (routeId: String) -> Unit,
    onDeleteRouteRequest: (route: Route) -> Unit,
    onDeleteConfirm: () -> Unit,
    onDeleteDismiss: () -> Unit,
    onToggleDay: (routeId: String, day: DayOfWeek) -> Unit,
    onToggleActive: (routeId: String) -> Unit,
    onReorder: (List<Route>) -> Unit,
    onToggleNotifications: () -> Unit,
    onToggleGpsTracking: () -> Unit,
    onOpenExactAlarmSettings: () -> Unit
) {
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val pullRefreshState = rememberPullRefreshState(
        refreshing = uiState.isRefreshing,
        onRefresh = onRefresh
    )
    var forecastExpanded by remember { mutableStateOf(true) }
    val chevronRotation by animateFloatAsState(
        targetValue = if (forecastExpanded) 180f else 0f,
        label = "forecastChevron"
    )
    var forecastSectionHeight by remember { mutableStateOf(0) }

    // Delete confirmation dialog
    uiState.pendingDeleteRoute?.let { route ->
        AlertDialog(
            onDismissRequest = onDeleteDismiss,
            title = { Text("Delete route") },
            text = { Text("Delete \"${route.title}\"? This cannot be undone.") },
            confirmButton = {
                TextButton(onClick = onDeleteConfirm) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = onDeleteDismiss) { Text("Cancel") }
            }
        )
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            SettingsDrawer(
                notificationsEnabled = uiState.notificationsEnabled,
                gpsTrackingEnabled = uiState.gpsTrackingEnabled,
                onToggleNotifications = onToggleNotifications,
                onToggleGpsTracking = onToggleGpsTracking,
                onOpenExactAlarmSettings = onOpenExactAlarmSettings
            )
        }
    ) {
    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("My Routes") },
                navigationIcon = {
                    IconButton(onClick = { scope.launch { drawerState.open() } }) {
                        Icon(Icons.Default.Menu, contentDescription = "Open settings")
                    }
                },
                actions = { TextButton(onClick = onLogoutClick) { Text("Logout") } }
            )
        },
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .pullRefresh(pullRefreshState)
                .padding(innerPadding)
                .padding(16.dp)
        ) {
            when {
                uiState.isInitialLoading && uiState.routes.isEmpty() -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState()),
                        contentAlignment = Alignment.Center
                    ) {
                        CircularProgressIndicator()
                    }
                }
                uiState.routes.isEmpty() -> {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text(
                            text = "No routes yet.",
                            style = MaterialTheme.typography.bodyLarge
                        )
                        Spacer(Modifier.height(16.dp))
                        AddRouteCard(onClick = onAddRouteClick)
                    }
                }
                else -> {
                    Column(modifier = Modifier.fillMaxSize()) {
                        Column(modifier = Modifier.onSizeChanged { forecastSectionHeight = it.height }) {
                            NextDepartureHeader(routes = uiState.routes)
                            Spacer(Modifier.height(8.dp))
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { forecastExpanded = !forecastExpanded }
                                    .padding(vertical = 4.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "Weekly Forecast",
                                    style = MaterialTheme.typography.titleSmall,
                                    fontWeight = FontWeight.SemiBold
                                )
                                Icon(
                                    imageVector = Icons.Default.KeyboardArrowDown,
                                    contentDescription = if (forecastExpanded) "Collapse forecast" else "Expand forecast",
                                    modifier = Modifier.rotate(chevronRotation)
                                )
                            }
                            AnimatedVisibility(visible = forecastExpanded) {
                                ForecastSheet(routes = uiState.routes)
                            }
                        }
                        Spacer(Modifier.height(6.dp))
                        RoutesList(
                            routes = uiState.routes,
                            onAddRouteClick = onAddRouteClick,
                            onEditRoute = onEditRoute,
                            onDeleteRoute = onDeleteRouteRequest,
                            onToggleDay = onToggleDay,
                            onToggleActive = onToggleActive,
                            onReorder = onReorder,
                            modifier = Modifier.weight(1f)
                        )
                    }
                }
            }

            uiState.errorMessage?.let { error ->
                Text(
                    text = error,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.align(Alignment.BottomCenter).padding(8.dp)
                )
            }

            PullRefreshIndicator(
                refreshing = uiState.isRefreshing,
                state = pullRefreshState,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .offset { IntOffset(0, forecastSectionHeight) }
            )
        }
    }
    } // ModalNavigationDrawer
}

@Composable
private fun SettingsDrawer(
    notificationsEnabled: Boolean,
    gpsTrackingEnabled: Boolean,
    onToggleNotifications: () -> Unit,
    onToggleGpsTracking: () -> Unit,
    onOpenExactAlarmSettings: () -> Unit
) {
    // Runtime permission launcher for POST_NOTIFICATIONS (Android 13+)
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) onToggleNotifications()
    }

    ModalDrawerSheet {
        Spacer(Modifier.height(16.dp))
        Text(
            text = "Preferences",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
        )
        HorizontalDivider()
        ListItem(
            headlineContent = { Text("Toggle notifications") },
            trailingContent = {
                Switch(
                    checked = notificationsEnabled,
                    onCheckedChange = { enabling ->
                        if (!enabling) {
                            // Turning off — no permission needed
                            onToggleNotifications()
                        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            // Android 13+: request POST_NOTIFICATIONS at runtime
                            permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                        } else {
                            // Below Android 13: permission granted at install time
                            onToggleNotifications()
                        }
                    }
                )
            }
        )
        if (notificationsEnabled) {
            ListItem(
                headlineContent = {
                    Text(
                        text = "Exact alarm permission required for timely alerts.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                },
                trailingContent = {
                    TextButton(onClick = onOpenExactAlarmSettings) {
                        Text("Open settings")
                    }
                }
            )
        }
        HorizontalDivider()
        ListItem(
            headlineContent = { Text("Opt in GPS data") },
            trailingContent = {
                Switch(
                    checked = gpsTrackingEnabled,
                    onCheckedChange = { onToggleGpsTracking() }
                )
            }
        )
        HorizontalDivider()
    }
}

@Composable
private fun AddRouteCard(
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = MaterialTheme.shapes.medium,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center
        ) {
            Icon(
                imageVector = Icons.Default.Add,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = "Add a new route",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface
            )
        }
    }
}

@Composable
private fun NextDepartureHeader(
    routes: List<Route>,
    modifier: Modifier = Modifier
) {
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = Instant.now()
        }
    }

    data class NextDeparture(val instant: Instant, val routeTitle: String, val reasoning: String)

    val dayKeyMap = mapOf(
        DayOfWeek.MONDAY    to "MON",
        DayOfWeek.TUESDAY   to "TUE",
        DayOfWeek.WEDNESDAY to "WED",
        DayOfWeek.THURSDAY  to "THU",
        DayOfWeek.FRIDAY    to "FRI",
        DayOfWeek.SATURDAY  to "SAT",
        DayOfWeek.SUNDAY    to "SUN"
    )

    val next = remember(routes, now) {
        routes
            .filter { it.userActive && it.forecast != null }
            .flatMap { route ->
                val activeKeys = route.schedule.activeDays.mapNotNull { dayKeyMap[it] }.toSet()
                route.forecast!!.days
                    .filterKeys { it in activeKeys }
                    .values
                    .mapNotNull { day ->
                        runCatching { Instant.parse(day.recommendation.adjustedDepartBy) }.getOrNull()
                            ?.let { instant -> NextDeparture(instant, route.title, day.recommendation.reasoning) }
                    }
            }
            .filter { it.instant.isAfter(now) }
            .minByOrNull { it.instant }
    }

    if (next == null) return

    val secondsUntil = ChronoUnit.SECONDS.between(now, next.instant)
    if (secondsUntil <= 0) return

    val hours = secondsUntil / 3600
    val minutes = (secondsUntil % 3600) / 60
    val timeLabel = if (hours > 0) "${hours}h ${minutes}m" else "${minutes}m"

    Surface(
        modifier = modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.primaryContainer,
        shape = MaterialTheme.shapes.medium
    ) {
        Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
            Text(
                text = "Your next departure",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer
            )
            Text(
                text = "in $timeLabel",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onPrimaryContainer
            )
            Text(
                text = next.routeTitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f)
            )
            if (next.reasoning.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = next.reasoning,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f)
                )
            }
        }
    }
}

@Composable
private fun RoutesList(
    routes: List<Route>,
    onAddRouteClick: () -> Unit,
    onEditRoute: (routeId: String) -> Unit,
    onDeleteRoute: (route: Route) -> Unit,
    onToggleDay: (routeId: String, day: DayOfWeek) -> Unit,
    onToggleActive: (routeId: String) -> Unit,
    onReorder: (List<Route>) -> Unit,
    modifier: Modifier = Modifier,
) {
    // orderedIds tracks drag order. Only reset when the set of IDs changes (add/delete).
    var orderedIds by remember { mutableStateOf(routes.map { it.id }) }

    LaunchedEffect(routes) {
        val incomingIds = routes.map { it.id }.toSet()
        if (incomingIds != orderedIds.toSet()) {
            orderedIds = routes.map { it.id }
        }
    }

    // routeMap and displayRoutes recompute synchronously in the same composition frame
    // when routes data changes (toggle, edit), so there is no async lag causing scroll jumps.
    val routeMap = remember(routes) { routes.associateBy { it.id } }
    val displayRoutes = remember(orderedIds, routeMap) { orderedIds.mapNotNull { routeMap[it] } }

    val lazyListState = rememberLazyListState()
    val reorderableState = rememberReorderableLazyListState(lazyListState) { from, to ->
        val newIds = orderedIds.toMutableList().apply {
            add(to.index, removeAt(from.index))
        }
        orderedIds = newIds
        onReorder(newIds.mapNotNull { routeMap[it] })
    }

    LazyColumn(
        state = lazyListState,
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        items(displayRoutes, key = { it.id }) { route ->
            ReorderableItem(reorderableState, key = route.id) { isDragging ->
                val haptic = LocalHapticFeedback.current
                LaunchedEffect(isDragging) {
                    if (isDragging) haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                }
                val scale by animateFloatAsState(
                    targetValue = if (isDragging) 1.03f else 1f,
                    label = "dragScale"
                )
                RouteItem(
                    route = route,
                    onEditClick = { onEditRoute(route.id) },
                    onDeleteClick = { onDeleteRoute(route) },
                    onToggleDay = { day -> onToggleDay(route.id, day) },
                    onToggleActive = { onToggleActive(route.id) },
                    modifier = Modifier
                        .longPressDraggableHandle()
                        .graphicsLayer { scaleX = scale; scaleY = scale }
                )
            }
        }
        item(key = "add_route_button") {
            AddRouteCard(onClick = onAddRouteClick)
        }
    }
}

@Composable
private fun RouteItem(
    route: Route,
    onEditClick: () -> Unit,
    onDeleteClick: () -> Unit,
    onToggleDay: (DayOfWeek) -> Unit,
    onToggleActive: () -> Unit,
    modifier: Modifier = Modifier
) {
    var menuExpanded by remember { mutableStateOf(false) }
    val alpha by animateFloatAsState(
        targetValue = if (route.userActive) 1f else 0.4f,
        label = "cardAlpha"
    )

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 4.dp)
                .alpha(alpha),
            verticalArrangement = Arrangement.spacedBy(2.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    route.title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f)
                )
                Box {
                    IconButton(onClick = { menuExpanded = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "Route options")
                    }
                    DropdownMenu(
                        expanded = menuExpanded,
                        onDismissRequest = { menuExpanded = false }
                    ) {
                        DropdownMenuItem(
                            text = { Text("Edit") },
                            onClick = {
                                menuExpanded = false
                                onEditClick()
                            }
                        )
                        DropdownMenuItem(
                            text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                            onClick = {
                                menuExpanded = false
                                onDeleteClick()
                            }
                        )
                    }
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                DepartureLabel(
                    forecastStatus = route.forecastStatus,
                    forecast = route.forecast
                )
                Spacer(Modifier.width(10.dp))
                DaysRow(
                    activeDays = route.schedule.activeDays,
                    enabled = route.userActive,
                    onToggle = onToggleDay,
                    modifier = Modifier.weight(1f)
                )
                Spacer(Modifier.width(10.dp))
                Switch(
                    checked = route.userActive,
                    onCheckedChange = { onToggleActive() }
                )
            }
        }
    }
}

@Composable
private fun DaysRow(
    activeDays: Set<DayOfWeek>,
    enabled: Boolean,
    onToggle: (DayOfWeek) -> Unit,
    modifier: Modifier = Modifier
) {
    val orderedDays = listOf(
        DayOfWeek.MONDAY to "M",
        DayOfWeek.TUESDAY to "Tu",
        DayOfWeek.WEDNESDAY to "W",
        DayOfWeek.THURSDAY to "Th",
        DayOfWeek.FRIDAY to "F",
        DayOfWeek.SATURDAY to "Sa",
        DayOfWeek.SUNDAY to "Su"
    )

    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        orderedDays.forEach { (day, label) ->
            val isActive = activeDays.contains(day)
            Surface(
                modifier = Modifier.clickable(enabled = enabled) { onToggle(day) },
                shape = MaterialTheme.shapes.small,
                color = if (isActive) {
                    Color(0xFF0FA253)
                } else {
                    MaterialTheme.colorScheme.surfaceVariant
                },
                contentColor = if (isActive) {
                    Color(0xFFFFFFFF)
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                }
            ) {
                Box(
                    modifier = Modifier
                        .width(24.dp)
                        .padding(vertical = 5.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = label,
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }
    }
}

@Composable
private fun DepartureLabel(
    forecastStatus: ForecastStatus,
    forecast: RouteForecast?
) {
    when {
        forecastStatus == ForecastStatus.PENDING -> {
            Text(
                text = "Pending",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        forecastStatus == ForecastStatus.EMPTY -> {
            Text(
                text = "—",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        forecast != null -> {
            val nextDepart = nextDepartureLabel(forecast)
            if (nextDepart != null) {
                Column {
                    Text(
                        text = "Depart",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        text = nextDepart,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium
                    )
                }
            } else {
                Text(
                    text = "—",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        else -> {
            Text(
                text = "—",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/**
 * Finds the next future departure across all forecast days and returns it as a local HH:mm string.
 */
private fun nextDepartureLabel(forecast: RouteForecast): String? {
    val zone = ZoneId.systemDefault()
    val now = Instant.now()
    val timeFormatter = DateTimeFormatter.ofPattern("HH:mm")

    return forecast.days.values
        .mapNotNull { day ->
            runCatching { Instant.parse(day.recommendation.adjustedDepartBy) }.getOrNull()
        }
        .filter { it.isAfter(now) }
        .minOrNull()
        ?.atZone(zone)
        ?.format(timeFormatter)
}

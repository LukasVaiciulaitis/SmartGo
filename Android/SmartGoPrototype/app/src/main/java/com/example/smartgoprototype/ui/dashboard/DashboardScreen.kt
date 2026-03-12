package com.example.smartgoprototype.ui.dashboard

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.ExperimentalMaterialApi
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.pullrefresh.PullRefreshIndicator
import androidx.compose.material.pullrefresh.pullRefresh
import androidx.compose.material.pullrefresh.rememberPullRefreshState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.smartgoprototype.domain.model.Route
import java.time.DayOfWeek

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
    onToggleActive: (routeId: String) -> Unit
) {
    val pullRefreshState = rememberPullRefreshState(
        refreshing = uiState.isRefreshing,
        onRefresh = onRefresh
    )

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

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Dashboard") },
                actions = { TextButton(onClick = onLogoutClick) { Text("Logout") } }
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = onAddRouteClick) {
                Icon(Icons.Default.Add, contentDescription = "Add route")
            }
        }
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
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState()),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = "No routes yet. Tap + to add one.",
                            style = MaterialTheme.typography.bodyLarge
                        )
                    }
                }
                else -> {
                    RoutesList(
                        routes = uiState.routes,
                        onEditRoute = onEditRoute,
                        onDeleteRoute = onDeleteRouteRequest,
                        onToggleDay = onToggleDay,
                        onToggleActive = onToggleActive,
                        modifier = Modifier.fillMaxSize()
                    )
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
                modifier = Modifier.align(Alignment.TopCenter)
            )
        }
    }
}

@Composable
private fun RoutesList(
    routes: List<Route>,
    onEditRoute: (routeId: String) -> Unit,
    onDeleteRoute: (route: Route) -> Unit,
    onToggleDay: (routeId: String, day: DayOfWeek) -> Unit,
    onToggleActive: (routeId: String) -> Unit,
    modifier: Modifier = Modifier
) {
    LazyColumn(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        items(routes) { route ->
            RouteItem(
                route = route,
                onEditClick = { onEditRoute(route.id) },
                onDeleteClick = { onDeleteRoute(route) },
                onToggleDay = { day -> onToggleDay(route.id, day) },
                onToggleActive = { onToggleActive(route.id) }
            )
        }
    }
}

@Composable
private fun RouteItem(
    route: Route,
    onEditClick: () -> Unit,
    onDeleteClick: () -> Unit,
    onToggleDay: (DayOfWeek) -> Unit,
    onToggleActive: () -> Unit
) {
    var menuExpanded by remember { mutableStateOf(false) }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
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
                Text(
                    text = formatDepartureTime(route.schedule.arriveByMinutes),
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium
                )
                Spacer(Modifier.width(10.dp))
                DaysRow(
                    activeDays = route.schedule.activeDays,
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
    onToggle: (DayOfWeek) -> Unit,
    modifier: Modifier = Modifier
) {
    val orderedDays = listOf(
        DayOfWeek.MONDAY to "M",
        DayOfWeek.TUESDAY to "T",
        DayOfWeek.WEDNESDAY to "W",
        DayOfWeek.THURSDAY to "T",
        DayOfWeek.FRIDAY to "F",
        DayOfWeek.SATURDAY to "S",
        DayOfWeek.SUNDAY to "S"
    )

    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        orderedDays.forEach { (day, label) ->
            val isActive = activeDays.contains(day)
            Surface(
                modifier = Modifier.clickable { onToggle(day) },
                shape = MaterialTheme.shapes.small,
                color = if (isActive) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.surfaceVariant
                },
                contentColor = if (isActive) {
                    MaterialTheme.colorScheme.onPrimary
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

private fun formatDepartureTime(totalMinutes: Int): String {
    val hour = (totalMinutes / 60).coerceIn(0, 23)
    val minute = (totalMinutes % 60).coerceIn(0, 59)
    return "%02d:%02d".format(hour, minute)
}

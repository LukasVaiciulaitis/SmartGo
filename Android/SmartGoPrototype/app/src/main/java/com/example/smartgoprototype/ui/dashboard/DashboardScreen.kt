package com.example.smartgoprototype.ui.dashboard

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.smartgoprototype.domain.model.Route
import java.time.format.TextStyle
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    uiState: DashboardUiState,
    onAddRouteClick: () -> Unit,
    onLogoutClick: () -> Unit
) {
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
                .padding(innerPadding)
                .padding(16.dp)
        ) {
            when {
                uiState.isLoading && uiState.routes.isEmpty() -> {
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                }
                uiState.routes.isEmpty() -> {
                    Text(
                        text = "No routes yet. Tap + to add one.",
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.align(Alignment.Center)
                    )
                }
                else -> {
                    RoutesList(routes = uiState.routes, modifier = Modifier.fillMaxSize())
                }
            }

            uiState.errorMessage?.let { error ->
                Text(
                    text = error,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.align(Alignment.BottomCenter).padding(8.dp)
                )
            }
        }
    }
}

@Composable
private fun RoutesList(routes: List<Route>, modifier: Modifier = Modifier) {
    LazyColumn(modifier = modifier) {
        items(routes) { route ->
            RouteItem(route)
            Divider()
        }
    }
}

@Composable
private fun RouteItem(route: Route) {
    val days = route.schedule.activeDays
        .sortedBy { it.value }
        .joinToString { it.getDisplayName(TextStyle.SHORT, Locale.getDefault()) }

    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text(route.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(4.dp))
        Text(
            text = "${route.origin.label.ifBlank { "Origin" }} → ${route.destination.label.ifBlank { "Destination" }}",
            style = MaterialTheme.typography.bodyMedium
        )
        Spacer(Modifier.height(2.dp))
        Text(
            text = "Arrive by: ${route.schedule.arriveByMinutes / 60}:${(route.schedule.arriveByMinutes % 60).toString().padStart(2, '0')} • $days",
            style = MaterialTheme.typography.bodySmall
        )
    }
}
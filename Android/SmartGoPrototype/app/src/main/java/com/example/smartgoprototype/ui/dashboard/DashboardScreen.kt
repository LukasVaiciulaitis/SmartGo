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
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text(
            route.title,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold
        )
    }
}

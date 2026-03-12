package com.example.smartgoprototype.ui.dashboard

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavHostController
import com.example.smartgoprototype.Routes
import kotlinx.coroutines.flow.collectLatest

@Composable
fun DashboardRoute(
    navController: NavHostController,
    onNavigateToAddRoute: () -> Unit,
    onNavigateToEditRoute: (routeId: String) -> Unit,
    viewModel: DashboardViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()
    val savedStateHandle = navController.currentBackStackEntry?.savedStateHandle

    LaunchedEffect(savedStateHandle) {
        val stateHandle = savedStateHandle ?: return@LaunchedEffect
        stateHandle.getStateFlow("route_created", false).collectLatest { created ->
            if (created) {
                viewModel.refresh()
                stateHandle["route_created"] = false
            }
        }
    }

    LaunchedEffect(Unit) {
        viewModel.signOutEvent.collectLatest {
            navController.navigate(Routes.LOGIN) {
                popUpTo(Routes.DASHBOARD) { inclusive = true }
            }
        }
    }

    DashboardScreen(
        uiState = uiState,
        onAddRouteClick = onNavigateToAddRoute,
        onRefresh = viewModel::refresh,
        onLogoutClick = viewModel::signOut,
        onEditRoute = onNavigateToEditRoute,
        onDeleteRouteRequest = viewModel::requestDelete,
        onDeleteConfirm = viewModel::confirmDelete,
        onDeleteDismiss = viewModel::dismissDeleteConfirmation,
        onToggleDay = viewModel::toggleDay
    )
}

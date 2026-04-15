package com.example.smartgoprototype.ui.dashboard

import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
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
    val context = LocalContext.current
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
        onToggleDay = viewModel::toggleDay,
        onToggleActive = viewModel::toggleRouteActive,
        onReorder = viewModel::reorderRoutes,
        onToggleNotifications = viewModel::toggleNotifications,
        onToggleGpsTracking = viewModel::toggleGpsTracking,
        onOpenExactAlarmSettings = {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                context.startActivity(
                    Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                )
            }
        }
    )
}
